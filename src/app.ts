import express from "express";
import skuRouter from "./sku/sku.router";
import inventoryRouter from "./inventory/inventory.router";
import requestLogger from "./lib/requestLogger";

const app = express();

app.use(express.json());
app.use(requestLogger);

app.use("/sku", skuRouter);
app.use("/inventory", inventoryRouter);
app.get("/health", (req: express.Request, res: express.Response) => {
	res.status(200).json({message: "OK"})
})

export default app;
