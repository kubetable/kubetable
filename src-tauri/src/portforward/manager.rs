use std::{
    collections::HashMap,
    io::Read,
    net::TcpStream,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TunnelKey {
    pub namespace: String,
    pub service: String,
    pub remote_port: u16,
    pub kubeconfig_path: Option<String>,
    pub kube_context: Option<String>,
}

#[derive(Debug)]
struct Tunnel {
    local_port: u16,
    child: Child,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

#[derive(Default, Clone)]
pub struct PortForwardManager {
    tunnels: Arc<Mutex<HashMap<TunnelKey, Tunnel>>>,
    next_port: Arc<Mutex<u16>>,
}

impl PortForwardManager {
    pub fn new() -> Self {
        Self {
            tunnels: Arc::new(Mutex::new(HashMap::new())),
            next_port: Arc::new(Mutex::new(15432)),
        }
    }

    pub fn ensure_tunnel(&self, key: &TunnelKey) -> crate::error::Result<u16> {
        {
            let mut tunnels = self.tunnels.lock().unwrap();
            if let Some(t) = tunnels.get_mut(key) {
                match t.child.try_wait() {
                    Ok(None) => {
                        let addr = format!("127.0.0.1:{}", t.local_port);
                        if TcpStream::connect_timeout(
                            &addr.parse().unwrap(),
                            Duration::from_millis(300),
                        ).is_ok() {
                            debug!("tunnel: reusing existing tunnel on port {} for {}/{}", t.local_port, key.namespace, key.service);
                            return Ok(t.local_port);
                        }
                        warn!("tunnel: existing tunnel on port {} failed TCP check, recreating for {}/{}", t.local_port, key.namespace, key.service);
                        tunnels.remove(key);
                    }
                    Ok(Some(status)) => {
                        warn!("tunnel: kubectl exited with {} for {}/{}, recreating", status, key.namespace, key.service);
                        tunnels.remove(key);
                    }
                    Err(e) => {
                        warn!("tunnel: try_wait error for {}/{}: {}, recreating", key.namespace, key.service, e);
                        tunnels.remove(key);
                    }
                }
            }
        }

        let local_port = {
            let mut p = self.next_port.lock().unwrap();
            let port = *p;
            *p += 1;
            port
        };

        let mut cmd = Command::new("kubectl");
        cmd.args(["port-forward", "-n", &key.namespace,
            &format!("svc/{}", key.service),
            &format!("{}:{}", local_port, key.remote_port),
        ]);
        if let Some(ref path) = key.kubeconfig_path {
            cmd.args(["--kubeconfig", path]);
        }
        if let Some(ref ctx) = key.kube_context {
            cmd.args(["--context", ctx]);
        }
        cmd.stdout(Stdio::null()).stderr(Stdio::piped());

        info!("tunnel: spawning kubectl port-forward for {}/{} on local port {}", key.namespace, key.service, local_port);
        let mut child = cmd.spawn()?;

        let addr = format!("127.0.0.1:{}", local_port);
        let start = Instant::now();
        let deadline = start + Duration::from_secs(8);
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                let mut msg = String::new();
                if let Some(mut e) = child.stderr.take() {
                    let _ = e.read_to_string(&mut msg);
                }
                return Err(crate::error::AppError::PortForward(format!(
                    "kubectl exited with {status}: {}", msg.trim()
                )));
            }

            if TcpStream::connect(&addr).is_ok() {
                // Give kubectl a moment to fully negotiate the channel to the pod.
                // TCP accepting connections doesn't mean the forwarding stream is stable.
                std::thread::sleep(Duration::from_millis(300));
                break;
            }

            if Instant::now() >= deadline {
                let _ = child.kill();
                let mut msg = String::new();
                if let Some(mut e) = child.stderr.take() {
                    let _ = e.read_to_string(&mut msg);
                }
                return Err(crate::error::AppError::PortForward(format!(
                    "kubectl port-forward timed out after 8s ({}:{}→{}). stderr: {}",
                    local_port, key.namespace, key.service, msg.trim()
                )));
            }

            std::thread::sleep(Duration::from_millis(150));
        }

        let mut tunnels = self.tunnels.lock().unwrap();
        if let Some(existing) = tunnels.get(key) {
            // Concurrent call already inserted one — drop ours and reuse theirs
            debug!("tunnel: concurrent tunnel already exists on port {}, dropping duplicate", existing.local_port);
            return Ok(existing.local_port);
        }
        info!("tunnel: ready on port {} for {}/{} (took {:?})", local_port, key.namespace, key.service, start.elapsed());
        tunnels.insert(key.clone(), Tunnel { local_port, child });
        Ok(local_port)
    }

    pub fn close_tunnel(&self, key: &TunnelKey) {
        if let Some(mut t) = self.tunnels.lock().unwrap().remove(key) {
            let _ = t.child.kill();
        }
    }

    pub fn active_tunnels(&self) -> Vec<(TunnelKey, u16)> {
        self.tunnels.lock().unwrap()
            .iter()
            .map(|(k, t)| (k.clone(), t.local_port))
            .collect()
    }

    pub fn shutdown(&self) {
        for (_, mut t) in self.tunnels.lock().unwrap().drain() {
            let _ = t.child.kill();
        }
    }
}
