import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { Surreal } from "surrealdb";

const app = new Hono();
let dbInstance: Surreal | null = null;

async function getDB(): Promise<Surreal> {
	if (dbInstance) return dbInstance;

	const db = new Surreal();
	const endpoint = process.env.SURREALDB_URL || "http://127.0.0.1:8000";
	const rpcUrl = endpoint.endsWith("/rpc") ? endpoint : `${endpoint.replace(/\/$/, "")}/rpc`;

	await db.connect(rpcUrl);
	await db.signin({
		username: process.env.SURREALDB_USER || "root",
		password: process.env.SURREALDB_PASS || "surrealdb_root_secret",
	});
	await db.use({
		namespace: process.env.SURREALDB_NS || "test",
		database: process.env.SURREALDB_DB || "app",
	});

	dbInstance = db;
	return db;
}

app.get("/health", async (c) => {
	try {
		const db = await getDB();
		await db.query("INFO FOR DB;");
		return c.json({ status: "ok", storage: "tikv", connected: true });
	} catch (error: any) {
		return c.json({ status: "degraded", error: error?.message }, 503);
	}
});

app.post("/users", async (c) => {
	try {
		const db = await getDB();
		const body = await c.req.json();
		const created = await db.create("user", {
			...body,
			createdAt: new Date().toISOString(),
		});
		return c.json(created, 201);
	} catch (error: any) {
		return c.json({ error: "Failed to create user", details: error?.message }, 500);
	}
});

app.get("/users", async (c) => {
	try {
		const db = await getDB();
		const users = await db.select("user");
		return c.json(users);
	} catch (error: any) {
		return c.json({ error: "Failed to fetch users", details: error?.message }, 500);
	}
});

export const handler = handle(app);
export default app;
