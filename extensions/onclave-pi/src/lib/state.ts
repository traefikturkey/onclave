import { join } from "node:path";

export type OnclavePaths = {
  root: string;
  privateKey: string;
};

export function getOnclavePaths(root: string): OnclavePaths {
  return {
    root,
    privateKey: join(root, "identity.key"),
  };
}
