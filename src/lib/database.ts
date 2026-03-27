import { MongoClient, Db, Document } from "mongodb";

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
