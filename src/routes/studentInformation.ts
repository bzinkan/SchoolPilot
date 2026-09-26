import {
  Router,
  raw,
  type Request,
  type Response,
  type NextFunction,
  type ErrorRequestHandler,
} from "express";
import { z, ZodError } from "zod";
import { authenticate } from "../middleware/authenticate.js";
import { requireSchoolContextWithoutTenantBinding } from "../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../middleware/requireActiveSchool.js";
import {
  myDeskActor,
  rejectMyDeskPrivilegedAccess,
  requireMyDeskAuthor,
} from "../middleware/requireMyDesk.js";
import { withSharedStudentRecords } from "../services/sharedStudentRecords.js";
import {
  getStudentContactProfile,
  updateStudentContactProfile,
  listStudentContactHistory,
  searchStudentInformation,
} from "../services/studentInformation.js";
import {
  informationId,
  INFORMATION_LIMITS,
  studentInformationImportEnabled,
} from "../services/studentInformationValidation.js";
import { myDeskImportLimits } from "../services/mydeskImportsValidation.js";
import {
  myDeskObjectStore,
  type MyDeskObjectStore,
} from "../services/mydeskFiles.js";
import {
  createInformationImport,
  getInformationImport,
  listInformationImports,
  reserveInformationAsset,
  uploadInformationAsset,
  readInformationAsset,
  processInformationImport,
  updateInformationItem,
  joinInformationItems,
  addInformationItem,
  commitInformationImport,
  cancelInformationImport,
} from "../services/studentInformationImports.js";

let activeUploads = 0;

export function createStudentInformationRouter(
  store: MyDeskObjectStore = myDeskObjectStore,
) {
  const router = Router();
  router.use((_req, res, next) => {
    res.set({
      "Cache-Control": "private, no-store",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    next();
  });
  router.use(
    authenticate,
    rejectMyDeskPrivilegedAccess,
    requireSchoolContextWithoutTenantBinding,
    requireActiveSchool,
    requireMyDeskAuthor,
  );
  const endpoint =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) => {
      void fn(req, res).catch(next);
    };
  router.get(
    "/capabilities",
    endpoint(async (req, res) =>
      res.json(
        await withSharedStudentRecords(
          myDeskActor(req, res),
          async (_tx, identity) => {
            let aiImportEnabled = false,
              importUnavailableCode: string | null = null,
              limits: ReturnType<typeof myDeskImportLimits> | null = null;
            try {
              limits = myDeskImportLimits();
              aiImportEnabled = studentInformationImportEnabled();
            } catch {
              importUnavailableCode = "STUDENT_INFORMATION_CONFIGURATION";
            }
            return {
              enabled: true,
              manager: identity.manager,
              aiImportEnabled,
              importProvider: "Anthropic",
              importUnavailableCode,
              limits: {
                ...INFORMATION_LIMITS,
                teacherDailyUnits: limits?.teacherDailyPages ?? null,
                schoolDailyUnits: limits?.schoolDailyPages ?? null,
              },
            };
          },
        ),
      ),
    ),
  );
  router.post(
    "/search",
    endpoint(async (req, res) =>
      res.json(await searchStudentInformation(myDeskActor(req, res), req.body)),
    ),
  );
  router.get(
    "/students/:studentId",
    endpoint(async (req, res) =>
      res.json(
        await getStudentContactProfile(
          myDeskActor(req, res),
          informationId.parse(req.params.studentId),
        ),
      ),
    ),
  );
  router.patch(
    "/students/:studentId",
    endpoint(async (req, res) =>
      res.json(
        await updateStudentContactProfile(
          myDeskActor(req, res),
          informationId.parse(req.params.studentId),
          req.body,
        ),
      ),
    ),
  );
  router.get(
    "/students/:studentId/history",
    endpoint(async (req, res) => {
      const { cursor } = z
        .object({ cursor: z.coerce.number().int().positive().optional() })
        .strict()
        .parse(req.query);
      return res.json(
        await listStudentContactHistory(
          myDeskActor(req, res),
          informationId.parse(req.params.studentId),
          cursor,
        ),
      );
    }),
  );
  router.get(
    "/imports",
    endpoint(async (req, res) => {
      const { cursor } = z
        .object({ cursor: informationId.optional() })
        .strict()
        .parse(req.query);
      return res.json(
        await listInformationImports(myDeskActor(req, res), cursor),
      );
    }),
  );
  router.post(
    "/imports",
    endpoint(async (req, res) =>
      res.json(await createInformationImport(myDeskActor(req, res), req.body)),
    ),
  );
  router.get(
    "/imports/:id",
    endpoint(async (req, res) =>
      res.json({
        import: await getInformationImport(
          myDeskActor(req, res),
          informationId.parse(req.params.id),
        ),
      }),
    ),
  );
  router.post(
    "/imports/:id/assets",
    endpoint(async (req, res) =>
      res.json(
        await reserveInformationAsset(
          myDeskActor(req, res),
          informationId.parse(req.params.id),
          req.body,
        ),
      ),
    ),
  );
  router.put(
    "/imports/:id/assets/:assetId/content",
    endpoint(async (req, res) => {
      if (activeUploads >= 2)
        throw Object.assign(
          new Error("Another source is being prepared. Retry shortly"),
          { status: 429, code: "STUDENT_INFORMATION_UPLOAD_BUSY" },
        );
      activeUploads++;
      try {
        await new Promise<void>((resolve, reject) =>
          raw({ type: () => true, limit: "10mb" })(req, res, (error) =>
            error ? reject(error) : resolve(),
          ),
        );
        if (!Buffer.isBuffer(req.body))
          throw Object.assign(new Error("Choose a file"), {
            status: 400,
            code: "STUDENT_INFORMATION_INVALID",
          });
        return res.json(
          await uploadInformationAsset(
            myDeskActor(req, res),
            informationId.parse(req.params.id),
            informationId.parse(req.params.assetId),
            req.body,
            (req.headers["content-type"] ?? "").split(";")[0]!,
            store,
          ),
        );
      } finally {
        activeUploads--;
      }
    }),
  );
  router.get(
    "/imports/:id/assets/:assetId/content",
    endpoint(async (req, res) => {
      const file = await readInformationAsset(
        myDeskActor(req, res),
        informationId.parse(req.params.id),
        informationId.parse(req.params.assetId),
        store,
      );
      res
        .set({
          "Content-Type": file.contentType,
          "Content-Security-Policy": "sandbox; default-src 'none'",
          "Content-Disposition":
            file.contentType === "text/plain"
              ? "inline"
              : 'attachment; filename="source"',
        })
        .send(file.bytes);
    }),
  );
  router.post(
    "/imports/:id/process",
    endpoint(async (req, res) =>
      res.json(
        await processInformationImport(
          myDeskActor(req, res),
          informationId.parse(req.params.id),
          req.body,
        ),
      ),
    ),
  );
  router.patch(
    "/imports/:id/items/:itemId",
    endpoint(async (req, res) =>
      res.json(
        await updateInformationItem(
          myDeskActor(req, res),
          informationId.parse(req.params.id),
          informationId.parse(req.params.itemId),
          req.body,
        ),
      ),
    ),
  );
  router.post(
    "/imports/:id/items",
    endpoint(async (req, res) =>
      res.json(
        await addInformationItem(
          myDeskActor(req, res),
          informationId.parse(req.params.id),
          req.body,
        ),
      ),
    ),
  );
  router.post(
    "/imports/:id/items/:itemId/join",
    endpoint(async (req, res) =>
      res.json(
        await joinInformationItems(
          myDeskActor(req, res),
          informationId.parse(req.params.id),
          informationId.parse(req.params.itemId),
          req.body,
        ),
      ),
    ),
  );
  router.post(
    "/imports/:id/commit",
    endpoint(async (req, res) =>
      res.json(
        await commitInformationImport(
          myDeskActor(req, res),
          informationId.parse(req.params.id),
          req.body,
        ),
      ),
    ),
  );
  router.delete(
    "/imports/:id",
    endpoint(async (req, res) =>
      res.json(
        await cancelInformationImport(
          myDeskActor(req, res),
          informationId.parse(req.params.id),
          req.body,
        ),
      ),
    ),
  );
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof ZodError) {
      res.status(400).json({
        code: "STUDENT_INFORMATION_INVALID",
        error: "Check the student information fields",
      });
      return;
    }
    const status =
        error instanceof Error && "status" in error ? error.status : undefined,
      code =
        error instanceof Error && "code" in error ? String(error.code) : "";
    if (
      typeof status === "number" &&
      status >= 400 &&
      status <= 599 &&
      (code.startsWith("STUDENT_INFORMATION_") ||
        code.startsWith("STUDENT_RECORD_"))
    ) {
      res.status(status).json({ code, error: (error as Error).message });
      return;
    }
    if (status === 401 || status === 403 || status === 404 || status === 413) {
      res.status(status).json({
        code: "STUDENT_INFORMATION_ACCESS_DENIED",
        error:
          status === 413
            ? "Choose a file no larger than 10 MiB"
            : "Student information access is unavailable",
      });
      return;
    }
    res.status(503).json({
      code: "STUDENT_INFORMATION_UNAVAILABLE",
      error: "Student information is temporarily unavailable",
    });
  };
  router.use(errors);
  return router;
}
export default createStudentInformationRouter();
