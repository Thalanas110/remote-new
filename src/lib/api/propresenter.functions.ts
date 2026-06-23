import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requestProPresenter } from "../propresenter-api.server.ts";

const proPresenterRequestSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .regex(/^https?:\/\//, "Base URL must start with http:// or https://"),
  path: z.string().min(1).regex(/^\//, "Path must start with /"),
  method: z.enum(["GET", "POST"]),
});

export const propresenterRequest = createServerFn({ method: "POST" })
  .validator(proPresenterRequestSchema)
  .handler(async ({ data }) => requestProPresenter(data));
