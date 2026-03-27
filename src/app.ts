import express from "express";
import SkuRouter from "./sku/sku.router";
import InventoryRouter from "./inventory/inventory.router";
import RequestLogger from "./lib/requestLogger";

const app = express();

app.use(express.json());
app.use(RequestLogger);

app.use("/sku", SkuRouter);
app.use("/inventory", InventoryRouter);
app.get("/health", (req: express.Request, res: express.Response) => {
	res.status(200).json({message: "OK"})
})

export default app;
