import { Router, type Request, type Response, type NextFunction } from "express";
import { myDeskActor } from "../middleware/requireMyDesk.js";
import { myDeskId, myDeskSeatingEnabledForSchool } from "../services/mydeskValidation.js";
import { seatingCreateInput, seatingUpdateInput, seatingDuplicateInput, seatingMutationInput, seatingListQuery } from "../services/mydeskSeatingValidation.js";
import { createMyDeskSeatingChart, listMyDeskSeatingCharts, getMyDeskSeatingChart, updateMyDeskSeatingChart,
  duplicateMyDeskSeatingChart, deleteMyDeskSeatingChart, setCurrentMyDeskSeatingChart } from "../services/mydeskSeating.js";

export const mydeskSeatingRouter = Router();
const endpoint = (handler: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  void handler(req, res).catch(next);
};
mydeskSeatingRouter.use("/seating-charts", (req, res, next) => {
  if (!myDeskSeatingEnabledForSchool(myDeskActor(req, res).schoolId)) {
    res.status(404).json({ error: "Seating charts are temporarily unavailable", code: "MYDESK_SEATING_NOT_ENABLED" }); return;
  }
  next();
});
mydeskSeatingRouter.get("/seating-charts", endpoint(async (req, res) =>
  res.json(await listMyDeskSeatingCharts(myDeskActor(req, res), seatingListQuery.parse(req.query)))));
mydeskSeatingRouter.post("/seating-charts", endpoint(async (req, res) => {
  const result = await createMyDeskSeatingChart(myDeskActor(req, res), seatingCreateInput.parse(req.body));
  return res.status(result.created ? 201 : 200).json({ chart: result.chart });
}));
mydeskSeatingRouter.get("/seating-charts/:id", endpoint(async (req, res) =>
  res.json({ chart: await getMyDeskSeatingChart(myDeskActor(req, res), myDeskId.parse(req.params.id)) })));
mydeskSeatingRouter.patch("/seating-charts/:id", endpoint(async (req, res) =>
  res.json({ chart: await updateMyDeskSeatingChart(myDeskActor(req, res), myDeskId.parse(req.params.id), seatingUpdateInput.parse(req.body)) })));
mydeskSeatingRouter.post("/seating-charts/:id/duplicate", endpoint(async (req, res) => {
  const result = await duplicateMyDeskSeatingChart(myDeskActor(req, res), myDeskId.parse(req.params.id), seatingDuplicateInput.parse(req.body));
  return res.status(result.created ? 201 : 200).json({ chart: result.chart });
}));
mydeskSeatingRouter.put("/seating-charts/:id/current", endpoint(async (req, res) =>
  res.json({ chart: await setCurrentMyDeskSeatingChart(myDeskActor(req, res), myDeskId.parse(req.params.id), seatingMutationInput.parse(req.body)) })));
mydeskSeatingRouter.delete("/seating-charts/:id", endpoint(async (req, res) => {
  await deleteMyDeskSeatingChart(myDeskActor(req, res), myDeskId.parse(req.params.id), seatingMutationInput.parse(req.body));
  return res.json({ ok: true });
}));
