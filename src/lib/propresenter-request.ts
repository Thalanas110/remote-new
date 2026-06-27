import { z } from "zod";

import { CLEARABLE_LAYERS, PP_PATHS } from "./propresenter-contract.ts";

const staticGetPaths = new Set<string>([
  PP_PATHS.version,
  PP_PATHS.activePresentation,
  PP_PATHS.slideIndex,
  PP_PATHS.previous,
  PP_PATHS.next,
  PP_PATHS.audienceScreens,
]);
const clearPattern = new RegExp(`^/v1/clear/layer/(${CLEARABLE_LAYERS.join("|")})$`);
const timerPattern = /^\/v1\/timer\/[^/]+\/(start|stop|reset)$/;

export const proPresenterRequestSchema = z
  .object({
    baseUrl: z
      .string()
      .url()
      .regex(/^https?:\/\//i, "Base URL must use HTTP or HTTPS"),
    path: z
      .string()
      .min(1)
      .regex(/^\//, "Path must start with /")
      .refine(
        (path) => staticGetPaths.has(path) || clearPattern.test(path) || timerPattern.test(path),
        "Unsupported ProPresenter endpoint",
      ),
    method: z.enum(["GET", "PUT"]),
    body: z.unknown().optional(),
  })
  .superRefine((request, context) => {
    const validPut = request.method === "PUT" && request.path === PP_PATHS.audienceScreens;
    const validGet = request.method === "GET" && request.body === undefined;
    if (!validPut && !validGet) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Method does not match endpoint" });
    }
    if (validPut && typeof request.body !== "boolean") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Audience screen body must be boolean",
      });
    }
  });

export type ProPresenterRequest = z.infer<typeof proPresenterRequestSchema>;
