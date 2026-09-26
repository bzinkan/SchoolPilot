import { Router, type Request, type Response, type NextFunction } from "express";
import { myDeskActor } from "../middleware/requireMyDesk.js";
import { myDeskId, myDeskSeatingEnabledForSchool } from "../services/mydeskValidation.js";
import { myDeskError } from "../services/mydesk.js";
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
  const input = seatingCreateInput.parse(req.body);
  const result = await createMyDeskSeatingChart(myDeskActor(req, res), input);
  if (input.layout.version < result.chart.layout.version) assertClientVersion(req, result.chart.layout.version);
  return res.status(result.created ? 201 : 200).json({ chart: result.chart });
}));
const assertClientVersion = (req: Request, version: number) => {
  if (version > 1 && req.query.layoutVersion !== "2") throw myDeskError(409, "MYDESK_SEATING_CLIENT_UPDATE_REQUIRED", "Reload My Desk to view this measured floor plan");
};
mydeskSeatingRouter.get("/seating-charts/:id", endpoint(async (req, res) => {
  const chart = await getMyDeskSeatingChart(myDeskActor(req, res), myDeskId.parse(req.params.id));
  assertClientVersion(req, chart.layout.version);
  return res.json({ chart });
}));
mydeskSeatingRouter.patch("/seating-charts/:id", endpoint(async (req, res) =>
  res.json({ chart: await updateMyDeskSeatingChart(myDeskActor(req, res), myDeskId.parse(req.params.id), seatingUpdateInput.parse(req.body)) })));
mydeskSeatingRouter.post("/seating-charts/:id/duplicate", endpoint(async (req, res) => {
  const source = await getMyDeskSeatingChart(myDeskActor(req, res), myDeskId.parse(req.params.id));
  assertClientVersion(req, source.layout.version);
  const result = await duplicateMyDeskSeatingChart(myDeskActor(req, res), myDeskId.parse(req.params.id), seatingDuplicateInput.parse(req.body), req.query.layoutVersion === "2" ? 2 : 1);
  assertClientVersion(req, result.chart.layout.version);
  return res.status(result.created ? 201 : 200).json({ chart: result.chart });
}));
mydeskSeatingRouter.put("/seating-charts/:id/current", endpoint(async (req, res) => {
  const source = await getMyDeskSeatingChart(myDeskActor(req, res), myDeskId.parse(req.params.id));
  assertClientVersion(req, source.layout.version);
  return res.json({ chart: await setCurrentMyDeskSeatingChart(myDeskActor(req, res), myDeskId.parse(req.params.id), seatingMutationInput.parse(req.body), req.query.layoutVersion === "2" ? 2 : 1) });
}));
mydeskSeatingRouter.delete("/seating-charts/:id", endpoint(async (req, res) => {
  await deleteMyDeskSeatingChart(myDeskActor(req, res), myDeskId.parse(req.params.id), seatingMutationInput.parse(req.body));
  return res.json({ ok: true });
}));
