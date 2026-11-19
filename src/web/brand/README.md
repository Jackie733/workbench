# 品牌素材

本目录收纳界面与浏览器图标实际使用的四个原始矢量/位图素材，来源为附件 `Workbench_Logo_Assets_v1.1_fixed.zip`（包内目录 `Workbench_Logo_Assets_v1`，manifest 标注 release 1.0、修订版 v1.1 fixed，基于 2026-11-18 已确认概念板重绘）。文件按附件原样保存，未重新导出或改色。

| 文件 | 附件原始路径 | SHA-256 |
| --- | --- | --- |
| `symbol-compact.svg` | `source/svg/symbol-compact.svg` | `12eb8be668b44fbb9d5b43392cf9735a27e07ce2af65e303c1db35f36ab2df7a` |
| `favicon.svg` | `platform/web/favicon.svg` | `a64d8524b9aeb2e772fdaefce1697d08893cd9189901282e74443a100e2d133e` |
| `favicon.ico` | `platform/web/favicon.ico` | `1451f156d436c413097a255904b0bf4bb1a71e7dcaf5e38b0318d25662b93411` |
| `apple-touch-icon.png` | `platform/web/apple-touch-icon.png` | `a54d6579d46811205604b9676afe300b62a2f38655ba7af49c31761ed3b244b2` |

浏览器图标在 `src/web/index.html` 中声明，`symbol-compact.svg` 由 `BrandMark` 组件从 `/brand/symbol-compact.svg` 加载；服务端仅按精确路径公开这四个文件。