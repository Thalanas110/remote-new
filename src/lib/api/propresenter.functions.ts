import { createServerFn } from "@tanstack/react-start";

import { requestProPresenter } from "../propresenter-api.server.ts";
import { proPresenterRequestSchema } from "../propresenter-request.ts";

export const propresenterRequest = createServerFn({ method: "POST" })
  .validator(proPresenterRequestSchema)
  .handler(async ({ data }) => requestProPresenter(data));
