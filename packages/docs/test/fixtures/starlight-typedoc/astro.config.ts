import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightTypeDoc from "starlight-typedoc";
export default defineConfig({ integrations: [starlight({ plugins: [starlightTypeDoc({})] })] });
