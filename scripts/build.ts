import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { projectRoot } from "../src/util.ts";

const output = join(projectRoot, "dist", "public");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(join(projectRoot, "src", "web"), output, { recursive: true });
process.stdout.write(`Built static Decision Card UI: ${output}\n`);
