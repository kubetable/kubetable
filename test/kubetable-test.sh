#!/usr/bin/env bash
# KubeTable test environment helper script
# Usage: ./kubetable-test.sh [up|down|status|logs]

set -euo pipefail

MANIFEST="$(dirname "$0")/kubetable-test.yaml"
NS="kubetable-test"

case "${1:-up}" in
  up)
    echo "Deploying KubeTable test environment..."
    kubectl apply -f "$MANIFEST"
    echo ""
    echo "Waiting for pods to become ready (this may take ~60s for first pull)..."
    kubectl wait --for=condition=ready pod -l app=postgres  -n "$NS" --timeout=120s
    kubectl wait --for=condition=ready pod -l app=mysql     -n "$NS" --timeout=120s
    kubectl wait --for=condition=ready pod -l app=redis     -n "$NS" --timeout=120s
    kubectl wait --for=condition=ready pod -l app=mongodb   -n "$NS" --timeout=120s
    echo ""
    echo "Waiting for seed pods to complete..."
    wait_seed() {
      local pod="$1"
      local deadline=$((SECONDS + 90))
      while [ $SECONDS -lt $deadline ]; do
        phase=$(kubectl get pod "$pod" -n "$NS" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
        case "$phase" in
          Succeeded) echo "  $pod: done"; return 0 ;;
          Failed)    echo "  $pod: FAILED"; return 1 ;;
          *)         sleep 3 ;;
        esac
      done
      echo "  $pod: timed out (still $phase)"
    }
    wait_seed postgres-seed
    wait_seed mysql-seed
    wait_seed redis-seed
    wait_seed mongodb-seed
    echo ""
    echo "Done! Services available in namespace '$NS':"
    echo "  postgres  → port 5432  (user: pgadmin / pass: pgpassword123 / db: testdb)"
    echo "  mysql     → port 3306  (user: root / pass: mysqlpassword123 / db: testdb)"
    echo "  redis     → port 6379  (pass: redispassword123)"
    echo "  mongodb   → port 27017 (user: mongoadmin / pass: mongopassword123 / db: testdb)"
    echo ""
    echo "Credentials are in Secrets named '<service>-credentials' in the '$NS' namespace."
    echo "KubeTable will auto-detect them when you click a service in the tree."
    ;;

  down)
    echo "Tearing down KubeTable test environment..."
    kubectl delete -f "$MANIFEST" --ignore-not-found
    echo "Done."
    ;;

  status)
    echo "=== Pods in $NS ==="
    kubectl get pods -n "$NS"
    echo ""
    echo "=== Services in $NS ==="
    kubectl get svc -n "$NS"
    ;;

  logs)
    DB="${2:-postgres}"
    echo "=== Logs for $DB writer ==="
    kubectl logs -n "$NS" -l "app=$DB-writer" --tail=50 -f
    ;;

  *)
    echo "Usage: $0 [up|down|status|logs [db]]"
    exit 1
    ;;
esac
