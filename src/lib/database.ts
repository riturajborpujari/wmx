import { MongoClient, Db, Document, WithTransactionCallback } from "mongodb";

let client: MongoClient;
let db    : Db;

export async function Connect(url: string, dbName: string) {
	try {
		client = new MongoClient(url, { tls: false, tlsInsecure: true });

		await client.connect();
		db = client.db(dbName);
	} catch (err: any) {
		throw new Error("Database Connect failed: " + err.message)
	}
}

export function GetCollection<T extends Document = Document>(collectionName: string) {
	return db.collection<T>(collectionName);
}

export async function RunTransaction<T = any>(handler: WithTransactionCallback<T>): Promise<T> {
	// TODO: Add transaction options support
	const session = client.startSession();
	try {
		const result = await session.withTransaction<T>(handler);
		await session.endSession();
		return result;
	} catch (err: any) {
		throw err;
	}
}
