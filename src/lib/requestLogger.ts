import { Request, Response, NextFunction } from "express";

export default function RequestLogger(
	req: Request,
	res: Response,
	next: NextFunction,
) {
	const reqTime = Date.now();

	let responseFinished = false;
	res.once("finish", () => {
		responseFinished = true;
		const resLatency = Date.now() - reqTime;
		console.log(
			`INFO: Request: ${req.method}: ${req.url}: ${res.statusCode}: ${resLatency}ms`,
		);
	});
	res.once("close", () => {
		if (!responseFinished) {
			const resLatency = Date.now() - reqTime;
			console.log(
				`INFO: Request: ${req.method}: ${req.url}: ${resLatency}ms: Client Aborted`,
			);
		}
	});
	next();
}
