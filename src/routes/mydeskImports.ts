import {
  Router,
  raw,
  type RequestHandler,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod";
import { myDeskActor } from "../middleware/requireMyDesk.js";
import {
  createMyDeskImport,
  createMyDeskImportFromAttachment,
  listMyDeskImports,
  getMyDeskImport,
  updateMyDeskImport,
  reserveMyDeskImportAsset,
  uploadMyDeskImportAsset,
  readMyDeskImportAsset,
  processMyDeskImport,
  createMyDeskImportItem,
  updateMyDeskImportItem,
  joinMyDeskImportItems,
  rereadMyDeskImportItem,
  commitMyDeskImport,
  cancelMyDeskImport,
} from "../services/mydeskImports.js";
import {
  importCreate,
  importFromAttachment,
  importUpdate,
  importReservation,
  importMutation,
  importItemCreate,
  importItemUpdate,
  importItemJoin,
  importCommit,
  IMPORT_MAX_BYTES,
} from "../services/mydeskImportsValidation.js";

export const mydeskImportsRouter = Router();
const myDeskEndpoint =
  (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
const id = z.string().uuid();
let uploads = 0;
const boundUploads: RequestHandler = (_req, res, next) => {
  if (uploads >= 2) {
    res
      .set("Retry-After", "2")
      .status(429)
      .json({
        error: "Other files are uploading. Retry shortly.",
        code: "MYDESK_IMPORT_UPLOAD_BUSY",
      });
    return;
  }
  uploads++;
  let released = false;
  res.locals.releaseImportUpload = () => {
    if (!released) {
      released = true;
      uploads--;
    }
  };
  const releaseUnread = () => {
    if (!res.locals.importUploadStarted) res.locals.releaseImportUpload();
  };
  res.once("finish", releaseUnread);
  res.once("close", releaseUnread);
  next();
};
mydeskImportsRouter.get(
  "/imports",
  myDeskEndpoint(async (req, res) =>
    res.json(await listMyDeskImports(myDeskActor(req, res), req.query)),
  ),
);
mydeskImportsRouter.post(
  "/imports",
  myDeskEndpoint(async (req, res) => {
    const result = await createMyDeskImport(
      myDeskActor(req, res),
      importCreate.parse(req.body),
    );
    return res
      .status(result.created ? 201 : 200)
      .json({ import: result.import });
  }),
);
mydeskImportsRouter.post(
  "/imports/from-attachment", boundUploads,
  myDeskEndpoint(async (req, res) => {
    res.locals.importUploadStarted = true;
    try {
      const result = await createMyDeskImportFromAttachment(myDeskActor(req, res), importFromAttachment.parse(req.body));
      return res.status(result.created ? 201 : 200).json({ import: result.import });
    } finally { res.locals.releaseImportUpload?.(); }
  }),
);
mydeskImportsRouter.get(
  "/imports/:id",
  myDeskEndpoint(async (req, res) =>
    res.json({
      import: await getMyDeskImport(
        myDeskActor(req, res),
        id.parse(req.params.id),
      ),
    }),
  ),
);
mydeskImportsRouter.patch(
  "/imports/:id",
  myDeskEndpoint(async (req, res) =>
    res.json({
      import: await updateMyDeskImport(
        myDeskActor(req, res),
        id.parse(req.params.id),
        importUpdate.parse(req.body),
      ),
    }),
  ),
);
mydeskImportsRouter.post(
  "/imports/:id/assets",
  myDeskEndpoint(async (req, res) =>
    res
      .status(201)
      .json({
        asset: await reserveMyDeskImportAsset(
          myDeskActor(req, res),
          id.parse(req.params.id),
          importReservation.parse(req.body),
        ),
      }),
  ),
);
mydeskImportsRouter.put(
  "/imports/:id/assets/:assetId/content",
  boundUploads,
  raw({ type: () => true, limit: IMPORT_MAX_BYTES }),
  myDeskEndpoint(async (req, res) => {
    res.locals.importUploadStarted = true;
    try {
      if (!Buffer.isBuffer(req.body))
        throw Object.assign(new Error("Choose a file"), {
          status: 400,
          code: "MYDESK_IMPORT_FILE_REQUIRED",
        });
      const contentType = (req.headers["content-type"] || "")
        .split(";")[0]!
        .trim();
      return res.json({
        asset: await uploadMyDeskImportAsset(
          myDeskActor(req, res),
          id.parse(req.params.id),
          id.parse(req.params.assetId),
          req.body,
          contentType,
        ),
      });
    } finally {
      res.locals.releaseImportUpload?.();
    }
  }),
);
mydeskImportsRouter.get(
  "/imports/:id/assets/:assetId/content",
  myDeskEndpoint(async (req, res) => {
    const result = await readMyDeskImportAsset(
      myDeskActor(req, res),
      id.parse(req.params.id),
      id.parse(req.params.assetId),
    );
    res.set("Content-Type", result.contentType);
    res.set("Content-Disposition", 'inline; filename="paperwork-preview"');
    return res.send(result.bytes);
  }),
);
mydeskImportsRouter.post(
  "/imports/:id/process",
  myDeskEndpoint(async (req, res) =>
    res.json({
      import: await processMyDeskImport(
        myDeskActor(req, res),
        id.parse(req.params.id),
        importMutation.parse(req.body),
      ),
    }),
  ),
);
mydeskImportsRouter.post(
  "/imports/:id/items",
  myDeskEndpoint(async (req, res) =>
    res.json({
      import: await createMyDeskImportItem(
        myDeskActor(req, res),
        id.parse(req.params.id),
        importItemCreate.parse(req.body),
      ),
    }),
  ),
);
mydeskImportsRouter.patch(
  "/imports/:id/items/:itemId",
  myDeskEndpoint(async (req, res) =>
    res.json({
      import: await updateMyDeskImportItem(
        myDeskActor(req, res),
        id.parse(req.params.id),
        id.parse(req.params.itemId),
        importItemUpdate.parse(req.body),
      ),
    }),
  ),
);
mydeskImportsRouter.post(
  "/imports/:id/items/:itemId/join",
  myDeskEndpoint(async (req, res) =>
    res.json({
      import: await joinMyDeskImportItems(
        myDeskActor(req, res),
        id.parse(req.params.id),
        id.parse(req.params.itemId),
        importItemJoin.parse(req.body),
      ),
    }),
  ),
);
mydeskImportsRouter.post(
  "/imports/:id/items/:itemId/reread",
  myDeskEndpoint(async (req, res) =>
    res.json({
      import: await rereadMyDeskImportItem(
        myDeskActor(req, res),
        id.parse(req.params.id),
        id.parse(req.params.itemId),
        importMutation
          .extend({ itemRevision: z.number().int().positive() })
          .strict()
          .parse(req.body),
      ),
    }),
  ),
);
mydeskImportsRouter.post(
  "/imports/:id/commit",
  myDeskEndpoint(async (req, res) =>
    res.json(
      await commitMyDeskImport(
        myDeskActor(req, res),
        id.parse(req.params.id),
        importCommit.parse(req.body),
      ),
    ),
  ),
);
mydeskImportsRouter.delete(
  "/imports/:id",
  myDeskEndpoint(async (req, res) =>
    res.json({
      import: await cancelMyDeskImport(
        myDeskActor(req, res),
        id.parse(req.params.id),
        importMutation.parse(req.body),
      ),
    }),
  ),
);
