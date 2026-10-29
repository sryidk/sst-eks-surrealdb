/// <reference path="./.sst/platform/config.d.ts" />

import { setupSurrealdb } from "./surrealdb";

export default $config({
	app(input) {
		return {
			name: "sst-eks-surrealdb",
			removal: input?.stage === "production" ? "retain" : "remove",
			home: "aws",
			providers: {
				aws: {
					region: "us-east-1",
				},
				eks: "2.7.8",
				kubernetes: "4.18.1",
			},
		};
	},
	async run() {
		const vpc = new sst.aws.Vpc("SurrealDBVpc", {
			az: 3,
			nat: "managed",
		});

		const { kubeconfig, surrealdbEndpoint, clusterName } =
			await setupSurrealdb(vpc);

		const honoApi = new sst.aws.Function("HonoService", {
			handler: "examples/hono-service/index.handler",
			url: true,
			timeout: "30 seconds",
			environment: {
				SURREALDB_URL: surrealdbEndpoint,
				SURREALDB_USER: process.env.SURREALDB_USER || "root",
				SURREALDB_PASS:
					process.env.SURREALDB_PASS || "surrealdb_root_secret",
				SURREALDB_NS: process.env.SURREALDB_NS || "test",
				SURREALDB_DB: process.env.SURREALDB_DB || "app",
			},
		});

		return {
			clusterName,
			surrealdbEndpoint,
			honoServiceUrl: honoApi.url,
			kubeconfig,
		};
	},
});
