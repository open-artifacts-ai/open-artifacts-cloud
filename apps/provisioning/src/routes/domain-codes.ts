import { RequestIdSchema } from "@oa/provisioning-contract";
import { z } from "zod";

export const DOMAIN_CODES_TOOL = "set_install_domain_codes";
export const DomainCodesBody = z
  .object({
    requestId: RequestIdSchema,
    domainCodes: z.boolean(),
  })
  .strict();
