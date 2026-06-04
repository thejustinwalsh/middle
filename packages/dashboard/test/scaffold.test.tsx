/**
 * #219 scaffold integration smoke: the Tailwind v4 + shadcn scaffold bundles and
 * serves through the real `Bun.serve` HTML-import path (the same path `mm start`
 * uses), and every vendored shadcn primitive mounts without throwing. This is the
 * foundation phase's evidence — no visual change yet, just "the toolchain is wired
 * and the primitives are renderable".
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createDbDeps } from "../src/db-deps.ts";
import { createDashboardServer } from "../src/server.ts";
import { Badge } from "../src/app/components/ui/badge.tsx";
import { Button } from "../src/app/components/ui/button.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../src/app/components/ui/collapsible.tsx";
import { Input } from "../src/app/components/ui/input.tsx";
import { Progress } from "../src/app/components/ui/progress.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../src/app/components/ui/select.tsx";
import { Sheet, SheetContent, SheetTitle } from "../src/app/components/ui/sheet.tsx";
import { Skeleton } from "../src/app/components/ui/skeleton.tsx";
import { Tabs, TabsList, TabsTrigger } from "../src/app/components/ui/tabs.tsx";
import { makeConfig, makeDb } from "./helpers.ts";

describe("#219 Tailwind/shadcn scaffold serves through the real bundler", () => {
  test("GET / bundles Tailwind: the served CSS contains compiled utilities (not literal class strings)", async () => {
    const { db, cleanup } = makeDb();
    const deps = createDbDeps({ db, config: makeConfig() });
    const server = await createDashboardServer({ deps, port: 0, serveSpa: true });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const html = await (await fetch(`${base}/`)).text();
      expect(html).toContain('id="root"');

      // main.tsx imports tailwind.css + styles.css; Bun emits them as separate
      // hashed assets, so aggregate every stylesheet link the shell pulls in.
      const links = [...html.matchAll(/href="([^"]+\.css)"/g)].map((m) => m[1]!);
      expect(links.length).toBeGreaterThan(0);
      const css = (await Promise.all(links.map((l) => fetch(base + l).then((r) => r.text())))).join(
        "\n",
      );

      // Tailwind actually compiled: real utility rules are present, and the
      // shadcn token-backed utilities the primitives use resolve to our palette
      // (not left as the literal class name).
      expect(css).toMatch(/\.rounded-md\b/);
      expect(css).toMatch(/\.bg-primary\b/);
      expect(css).not.toContain("@apply");
      expect(css.length).toBeGreaterThan(2000);
    } finally {
      server.stop(true);
      cleanup();
    }
  });

  test("every vendored shadcn primitive mounts without throwing and carries its data-slot", () => {
    const html = renderToStaticMarkup(
      <div>
        <Button>go</Button>
        <Badge variant="success">live</Badge>
        <Input defaultValue="x" />
        <Progress value={50} />
        <Skeleton className="h-4 w-20" />
        <Tabs value="a">
          <TabsList>
            <TabsTrigger value="a">a</TabsTrigger>
          </TabsList>
        </Tabs>
        <Collapsible open>
          <CollapsibleTrigger>t</CollapsibleTrigger>
          <CollapsibleContent>c</CollapsibleContent>
        </Collapsible>
        <Select defaultValue="a">
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">a</SelectItem>
          </SelectContent>
        </Select>
        <Sheet>
          <SheetContent side="bottom">
            <SheetTitle>title</SheetTitle>
          </SheetContent>
        </Sheet>
      </div>,
    );
    for (const slot of ["button", "badge", "input", "progress", "skeleton", "tabs-trigger"]) {
      expect(html).toContain(`data-slot="${slot}"`);
    }
  });
});
