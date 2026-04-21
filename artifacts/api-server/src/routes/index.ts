import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import testsRouter from "./tests.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/tests", testsRouter);

export default router;
