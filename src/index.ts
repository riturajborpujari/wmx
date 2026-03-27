import http from "http";
import app from "./app";
import * as Db from "./lib/database";

async function bootstrap() {
	console.log("INFO: Connecting to database...");
	await Db.Connect("mongodb://127.0.0.1:27017", "wmx");

	console.log("INFO: Initializing HTTP server...");
	const server = http.createServer(app);
	server.listen(8080, () => {
		console.log("INFO: wmx server running at:", "http://localhost:8080");
	})
}

bootstrap()
	.catch(err => {
		console.error("FATAL:", err.message);
	})
