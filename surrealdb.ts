import * as aws from "@pulumi/aws";
import * as eks from "@pulumi/eks";
import * as kubernetes from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export interface SurrealDbClusterOutputs {
	kubeconfig: pulumi.Output<any>;
	surrealdbEndpoint: pulumi.Output<string>;
	clusterName: pulumi.Output<string>;
}

export const setupSurrealdb = async (
	vpc: sst.aws.Vpc,
): Promise<SurrealDbClusterOutputs> => {
	// 1. Provision EKS Cluster with OIDC Provider enabled (required for EBS CSI IRSA)
	const cluster = new eks.Cluster("SurrealDBCluster", {
		vpcId: vpc.id,
		publicSubnetIds: vpc.publicSubnets,
		privateSubnetIds: vpc.privateSubnets,
		instanceType: "t3.medium",
		desiredCapacity: 2,
		minSize: 1,
		maxSize: 3,
		storageClasses: {
			gp3: {
				type: "gp3",
				default: true,
				encrypted: true,
				allowVolumeExpansion: true,
			},
		},
		createOidcProvider: true,
		skipDefaultNodeGroup: false,
	});

	// 2. Attach AmazonEBSCSIDriverPolicy to Worker Node Role + OIDC IRSA Role
	const instanceRole = cluster.instanceRoles.apply((roles) => roles[0]);

	const nodeEbsPolicyAttachment = new aws.iam.RolePolicyAttachment(
		"node-ebs-csi-policy",
		{
			role: instanceRole.apply((r) => r.name),
			policyArn: "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy",
		},
	);

	const ebsCsiAddon = new eks.Addon(
		"aws-ebs-csi-driver",
		{
			cluster: cluster,
			addonName: "aws-ebs-csi-driver",
		},
		{ dependsOn: [nodeEbsPolicyAttachment] },
	);

	// 3. Dedicated Managed Node Group for PD (Placement Driver)
	const pdNodeGroup = new eks.ManagedNodeGroup("pd-nodegroup", {
		cluster: cluster,
		nodeGroupName: "pd-nodes",
		instanceTypes: ["t3.medium"],
		amiType: "AL2023_x86_64_STANDARD",
		scalingConfig: {
			desiredSize: 1,
			minSize: 1,
			maxSize: 3,
		},
		labels: { dedicated: "pd" },
		taints: [{ key: "dedicated", value: "pd", effect: "NO_SCHEDULE" }],
		subnetIds: vpc.privateSubnets,
		nodeRole: instanceRole,
	});

	// 4. Dedicated Managed Node Group for TiKV Storage Engine
	const tikvNodeGroup = new eks.ManagedNodeGroup("tikv-nodegroup", {
		cluster: cluster,
		nodeGroupName: "tikv-nodes",
		instanceTypes: ["m6i.large"],
		amiType: "AL2023_x86_64_STANDARD",
		scalingConfig: {
			desiredSize: 3,
			minSize: 3,
			maxSize: 6,
		},
		labels: { dedicated: "tikv" },
		taints: [{ key: "dedicated", value: "tikv", effect: "NO_SCHEDULE" }],
		subnetIds: vpc.privateSubnets,
		nodeRole: instanceRole,
	});

	// 5. Kubernetes Provider with Server-Side Apply enabled
	// Critical fix: TiDB Operator CRD manifest exceeds 262KB annotation limit under Client-Side Apply
	const provider = new kubernetes.Provider("eks-provider", {
		kubeconfig: cluster.kubeconfigJson,
		enableServerSideApply: true,
	});

	const tidbCrds = new kubernetes.yaml.ConfigFile(
		"tidb-crds",
		{
			file: "https://raw.githubusercontent.com/pingcap/tidb-operator/v1.6.1/manifests/crd.yaml",
		},
		{ provider },
	);

	const tidbOperatorNamespace = new kubernetes.core.v1.Namespace(
		"tidb-operator-ns",
		{ metadata: { name: "tidb-operator" } },
		{ provider },
	);

	const tidbOperator = new kubernetes.helm.v3.Release(
		"tidb-operator",
		{
			chart: "tidb-operator",
			version: "v1.6.1",
			repositoryOpts: { repo: "https://charts.pingcap.org" },
			namespace: tidbOperatorNamespace.metadata.name,
			values: {
				controllerManager: { replicas: 1 },
				scheduler: { create: false },
			},
		},
		{ provider, dependsOn: [tidbCrds, tidbOperatorNamespace] },
	);

	const tidbClusterNamespace = new kubernetes.core.v1.Namespace(
		"tidb-cluster-ns",
		{ metadata: { name: "tidb-cluster" } },
		{ provider },
	);

	// 6. Deploy PD + TiKV Cluster (SurrealDB connects directly to PD/TiKV via tikv:// protocol)
	const tidbCluster = new kubernetes.apiextensions.CustomResource(
		"tidb-cluster",
		{
			apiVersion: "pingcap.com/v1alpha1",
			kind: "TidbCluster",
			metadata: {
				name: "basic",
				namespace: tidbClusterNamespace.metadata.name,
			},
			spec: {
				version: "v8.5.0",
				timezone: "UTC",
				pvReclaimPolicy: "Delete",
				tlsCluster: { enabled: false },
				pd: {
					baseImage: "pingcap/pd",
					replicas: 1,
					storageClassName: "gp3",
					requests: { storage: "10Gi" },
					nodeSelector: { dedicated: "pd" },
					tolerations: [
						{ key: "dedicated", value: "pd", effect: "NoSchedule" },
					],
				},
				tikv: {
					baseImage: "pingcap/tikv",
					replicas: 3,
					storageClassName: "gp3",
					requests: { storage: "20Gi" },
					nodeSelector: { dedicated: "tikv" },
					tolerations: [
						{ key: "dedicated", value: "tikv", effect: "NoSchedule" },
					],
				},
			},
		},
		{
			provider,
			dependsOn: [
				tidbOperator,
				tidbClusterNamespace,
				pdNodeGroup,
				tikvNodeGroup,
				ebsCsiAddon,
			],
		},
	);

	// 7. Deploy SurrealDB Stateless Compute Layer backed by TiKV
	const surrealUsername = process.env.SURREALDB_USER || "root";
	const surrealPassword = process.env.SURREALDB_PASS || "surrealdb_root_secret";

	const surrealdbRelease = new kubernetes.helm.v3.Release(
		"surrealdb",
		{
			chart: "surrealdb",
			repositoryOpts: { repo: "https://surrealdb.github.io/helm-charts" },
			version: "0.3.7",
			namespace: "default",
			values: {
				replicaCount: 2,
				image: {
					pullPolicy: "IfNotPresent",
					repository: "surrealdb/surrealdb",
					tag: "v2.2.2",
				},
				surrealdb: {
					auth: true,
					path: "tikv://basic-pd.tidb-cluster:2379",
					initialUser: surrealUsername,
					initialPassword: surrealPassword,
					log: "info",
				},
				service: {
					type: "LoadBalancer",
					port: 8000,
					annotations: {
						"service.beta.kubernetes.io/aws-load-balancer-type": "nlb",
						"service.beta.kubernetes.io/aws-load-balancer-scheme":
							"internet-facing",
					},
				},
			},
		},
		{ provider, dependsOn: [tidbCluster] },
	);

	const surrealService = kubernetes.core.v1.Service.get(
		"surrealdb-svc",
		pulumi.interpolate`default/${surrealdbRelease.name}`,
		{ provider, dependsOn: [surrealdbRelease] },
	);

	const surrealdbEndpoint = surrealService.status.apply((status) => {
		const ingress = status?.loadBalancer?.ingress?.[0];
		const host = ingress?.hostname || ingress?.ip || "localhost";
		return `http://${host}:8000`;
	});

	return {
		kubeconfig: cluster.kubeconfigJson,
		surrealdbEndpoint,
		clusterName: cluster.eksCluster.name,
	};
};
