# Deploying Distributed SurrealDB on TiKV over Amazon EKS with SST v3 & Pulumi

## 1. Root Cause Analysis of Previous Deployment Issues & Architectural Fixes

1. **SST v2 vs. SST v3 (Ion/Pulumi) Mismatch**:
   - The repository previously mixed an SST v2 CDK `SSTConfig` (`sst.config.ts` / `src/EksStack.ts`) with an SST v3 Pulumi implementation (`surrealdb.ts`).
   - **Fix**: Unified the entire stack around **SST v3 (`$config`)** and Pulumi (`@pulumi/eks` + `@pulumi/kubernetes`), wiring outputs directly from the EKS/Helm deployment into the serverless `HonoService` function.

2. **Kubernetes 262KB CRD Annotation Limit (`tidb-crds`)**:
   - Applying PingCAP's `crd.yaml` (which exceeds 1.5MB) via standard client-side `kubectl apply` fails on EKS 1.28+ with `metadata.annotations: Too long: must have at most 262144 bytes`.
   - **Fix**: Enabled `enableServerSideApply: true` on the Pulumi `kubernetes.Provider`.

3. **EBS CSI Driver IAM Permissions & PVC Provisioning (`gp3`)**:
   - Without `AmazonEBSCSIDriverPolicy` attached to the worker node IAM role and OIDC provider enabled (`createOidcProvider: true`), PD (`10Gi`) and TiKV (`20Gi`) PVCs remain permanently stuck in `Pending`.
   - **Fix**: Attached `arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy` to the EKS node role prior to installing the `aws-ebs-csi-driver` addon, and defined `gp3` as the default encrypted StorageClass.

4. **Elimination of Redundant TiDB SQL Layer**:
   - SurrealDB communicates directly with TiKV via the Placement Driver (`tikv://basic-pd.tidb-cluster:2379`). Deploying the TiDB SQL layer node group (`tidb-nodegroup`) wasted EC2 compute and slowed cluster bootstrap.
   - **Fix**: Streamlined the `TidbCluster` custom resource to provision dedicated `pd` and `tikv` node groups (3 replicas for TiKV raft quorum).

5. **SurrealDB v2 Authentication & Hono Lambda Integration**:
   - Enabled SurrealDB root authentication (`surrealdb.auth: true`) with configurable `SURREALDB_USER` / `SURREALDB_PASS`, exposed SurrealDB via an AWS NLB LoadBalancer service, and updated `examples/hono-service/index.ts` to export an AWS Lambda `handler` using `hono/aws-lambda` and `surrealdb` v1.x RPC connection semantics.

---

## 2. Infrastructure Architecture

```
+-----------------------------------------------------------------------------------+
|                                AWS VPC (3 AZs)                                    |
|                                                                                   |
|  +-------------------------+       HTTP /rpc        +--------------------------+  |
|  |  Hono Service (Lambda)  | ---------------------> | AWS NLB (LoadBalancer)   |  |
|  |  GET/POST /users        |                        +------------+-------------+  |
|  +-------------------------+                                     |                |
|                                                                  v                |
|  +-----------------------------------------------------------------------------+  |
|  |                            Amazon EKS Cluster                               |  |
|  |                                                                             |  |
|  |  [Default NodeGroup: t3.medium]                                             |  |
|  |    +-- SurrealDB Stateless Pods (x2, v2.2.2)                                |  |
|  |    +-- TiDB Operator (v1.6.1, namespace: tidb-operator)                     |  |
|  |                     |                                                       |  |
|  |                     | tikv://basic-pd.tidb-cluster:2379                     |  |
|  |                     v                                                       |  |
|  |  [Dedicated PD NodeGroup: t3.medium, taint: dedicated=pd:NoSchedule]        |  |
|  |    +-- PD Pod (Placement Driver + 10Gi gp3 EBS PVC)                         |  |
|  |                     |                                                       |  |
|  |                     v                                                       |  |
|  |  [Dedicated TiKV NodeGroup: m6i.large x3, taint: dedicated=tikv:NoSchedule] |  |
|  |    +-- TiKV Pod 0 (20Gi gp3 EBS PVC)                                        |  |
|  |    +-- TiKV Pod 1 (20Gi gp3 EBS PVC)                                        |  |
|  |    +-- TiKV Pod 2 (20Gi gp3 EBS PVC)                                        |  |
|  +-----------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------+
```

---

## 3. Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `AWS_REGION` | `us-east-1` | Target AWS deployment region |
| `SURREALDB_USER` | `root` | Initial SurrealDB root username |
| `SURREALDB_PASS` | `surrealdb_root_secret` | Initial SurrealDB root password |
| `SURREALDB_NS` | `test` | Target SurrealDB namespace for Hono service |
| `SURREALDB_DB` | `app` | Target SurrealDB database for Hono service |

---

## 4. Step-by-Step Deployment Instructions

```bash
# 1. Install dependencies
pnpm install

# 2. Configure credentials
export AWS_REGION="us-east-1"
export SURREALDB_USER="root"
export SURREALDB_PASS="StrongSurrealPass2026!"

# 3. Deploy full stack (VPC + EKS + TiDB Operator + PD/TiKV + SurrealDB + Hono API)
npx sst deploy --stage dev
```

---

## 5. Verification & Testing

Once `sst deploy` completes, it outputs `honoServiceUrl` and `surrealdbEndpoint`:

```bash
# Check health & TiKV storage connectivity
curl -s "${HONO_SERVICE_URL}/health"
# -> {"status":"ok","storage":"tikv","connected":true}

# Create a user record stored in TiKV via SurrealDB
curl -X POST "${HONO_SERVICE_URL}/users" \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice", "role": "architect"}'

# Query all users
curl -s "${HONO_SERVICE_URL}/users"
```

---

## 6. Cleanup Instructions

To avoid ongoing AWS EKS, NAT Gateway, NLB, and EBS charges:

```bash
npx sst remove --stage dev
```
