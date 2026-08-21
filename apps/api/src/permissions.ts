import { createAccessControl } from "better-auth/plugins/access";
import {
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

const statements = {
  ...defaultStatements,
  asset: ["read", "create", "update", "delete", "publish"],
  domain: ["read", "manage"],
  preset: ["read", "manage"],
  apiKey: ["create", "read", "update", "delete"],
  workspace: ["manage"],
} as const;

export const access = createAccessControl(statements);
export const roles = {
  owner: access.newRole({
    ...ownerAc.statements,
    asset: statements.asset,
    domain: statements.domain,
    preset: statements.preset,
    apiKey: statements.apiKey,
    workspace: statements.workspace,
  }),
  editor: access.newRole({
    ...memberAc.statements,
    asset: ["read", "create", "update", "delete", "publish"],
    domain: ["read"],
    preset: ["read", "manage"],
  }),
  viewer: access.newRole({
    ...memberAc.statements,
    asset: ["read"],
    domain: ["read"],
    preset: ["read"],
  }),
};
