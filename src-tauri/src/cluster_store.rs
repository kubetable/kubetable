use std::path::{Path, PathBuf};

use kube::config::{KubeConfigOptions, Kubeconfig};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterSource {
    pub id: String,
    pub label: String,
    #[serde(flatten)]
    pub kind: ClusterSourceKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ClusterSourceKind {
    Default,
    File { path: String },
    Saved,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterSourceInfo {
    #[serde(flatten)]
    pub source: ClusterSource,
    pub contexts: Vec<String>,
    pub current_context: Option<String>,
}

pub struct ClusterStore {
    data_dir: PathBuf,
}

impl ClusterStore {
    pub fn new(data_dir: PathBuf) -> Self {
        std::fs::create_dir_all(data_dir.join("clusters")).ok();
        Self { data_dir }
    }

    fn sources_path(&self) -> PathBuf {
        self.data_dir.join("sources.json")
    }

    /// Filesystem path of a saved kubeconfig (only meaningful for File/Saved kinds).
    pub fn kubeconfig_path_for(&self, source: &ClusterSource) -> Option<PathBuf> {
        match &source.kind {
            ClusterSourceKind::Default => None,
            ClusterSourceKind::File { path } => Some(PathBuf::from(path)),
            ClusterSourceKind::Saved => Some(self.data_dir.join("clusters").join(format!("{}.yaml", source.id))),
        }
    }

    pub fn list_sources(&self) -> Vec<ClusterSource> {
        let mut out = vec![ClusterSource {
            id: "default".into(),
            label: "Default (~/.kube/config)".into(),
            kind: ClusterSourceKind::Default,
        }];
        out.extend(self.load_saved());
        out
    }

    pub fn get_source(&self, id: &str) -> Option<ClusterSource> {
        if id == "default" {
            return Some(ClusterSource {
                id: "default".into(),
                label: "Default (~/.kube/config)".into(),
                kind: ClusterSourceKind::Default,
            });
        }
        self.load_saved().into_iter().find(|s| s.id == id)
    }

    pub fn list_sources_with_contexts(&self) -> Vec<ClusterSourceInfo> {
        self.list_sources()
            .into_iter()
            .map(|source| {
                let (contexts, current_context) = self
                    .read_kubeconfig(&source)
                    .map(|kc| {
                        let ctxs = kc.contexts.iter().map(|c| c.name.clone()).collect();
                        (ctxs, kc.current_context)
                    })
                    .unwrap_or_default();
                ClusterSourceInfo { source, contexts, current_context }
            })
            .collect()
    }

    pub fn read_kubeconfig(&self, source: &ClusterSource) -> Result<Kubeconfig> {
        match &source.kind {
            ClusterSourceKind::Default => Ok(Kubeconfig::read()?),
            ClusterSourceKind::File { path } => Ok(Kubeconfig::read_from(Path::new(path))?),
            ClusterSourceKind::Saved => {
                let path = self.data_dir.join("clusters").join(format!("{}.yaml", source.id));
                let content = std::fs::read_to_string(path)?;
                serde_yaml::from_str(&content).map_err(|e| AppError::Other(e.to_string()))
            }
        }
    }

    pub async fn build_client(&self, source_id: &str, context: Option<&str>) -> Result<kube::Client> {
        let source = self
            .get_source(source_id)
            .ok_or_else(|| AppError::Other(format!("Unknown cluster source: {}", source_id)))?;

        let kubeconfig = self.read_kubeconfig(&source)?;
        let options = KubeConfigOptions {
            context: context.filter(|s| !s.is_empty()).map(str::to_string),
            ..Default::default()
        };
        let config = kube::Config::from_custom_kubeconfig(kubeconfig, &options).await?;
        Ok(kube::Client::try_from(config)?)
    }

    pub fn add_file(&self, path: String) -> Result<ClusterSource> {
        // Validate before saving
        let tmp = ClusterSource { id: String::new(), label: String::new(), kind: ClusterSourceKind::File { path: path.clone() } };
        self.read_kubeconfig(&tmp)?;

        let label = PathBuf::from(&path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());

        let source = ClusterSource { id: new_id(), label, kind: ClusterSourceKind::File { path } };
        self.append(&source)?;
        Ok(source)
    }

    pub fn add_yaml(&self, label: String, yaml: String) -> Result<ClusterSource> {
        serde_yaml::from_str::<Kubeconfig>(&yaml)
            .map_err(|e| AppError::Other(format!("Invalid kubeconfig YAML: {}", e)))?;

        let id = new_id();
        let yaml_path = self.data_dir.join("clusters").join(format!("{}.yaml", id));
        std::fs::write(&yaml_path, &yaml)?;

        let source = ClusterSource { id, label, kind: ClusterSourceKind::Saved };
        self.append(&source)?;
        Ok(source)
    }

    pub fn remove_source(&self, id: &str) -> Result<()> {
        if id == "default" {
            return Err(AppError::Other("Cannot remove the default config".into()));
        }
        let mut saved = self.load_saved();
        saved.retain(|s| s.id != id);
        self.write_saved(&saved)?;
        let _ = std::fs::remove_file(self.data_dir.join("clusters").join(format!("{}.yaml", id)));
        Ok(())
    }

    fn append(&self, source: &ClusterSource) -> Result<()> {
        let mut saved = self.load_saved();
        saved.push(source.clone());
        self.write_saved(&saved)
    }

    fn load_saved(&self) -> Vec<ClusterSource> {
        std::fs::read(&self.sources_path())
            .ok()
            .and_then(|d| serde_json::from_slice(&d).ok())
            .unwrap_or_default()
    }

    fn write_saved(&self, sources: &[ClusterSource]) -> Result<()> {
        let json = serde_json::to_vec_pretty(sources).map_err(|e| AppError::Other(e.to_string()))?;
        std::fs::write(&self.sources_path(), json)?;
        Ok(())
    }
}

fn new_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().subsec_nanos();
    format!("{:x}{:x}", nanos, nanos.wrapping_mul(2654435761))
}
