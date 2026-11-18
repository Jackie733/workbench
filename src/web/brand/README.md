# 品牌素材

本目录收纳界面与浏览器图标实际使用的四个原始矢量/位图素材，来源为 `Workbench_Logo_Assets_v1`（产品 Workbench，release 1.0，manifest 标注“基于 2026-11-18 已确认概念板的矢量重绘”）。文件按附件原样保存，未重新导出或改色。

| 文件 | 附件原始路径 | SHA-256 |
| --- | --- | --- |
| `symbol-compact.svg` | `source/svg/symbol-compact.svg` | `4290d1918daedfda5a061315565b86282d04aa473adac3af6cf2e067cec7ace0` |
| `favicon.svg` | `platform/web/favicon.svg` | `cfeb14b06fe8140570d4e332a69feff1c6dd81c670b7440da6ec6f8b80c42164` |
| `favicon.ico` | `platform/web/favicon.ico` | `8605b1aa5be949d6268338fbd64bff5d9eb9692eb4576b4635f6f71d88317086` |
| `apple-touch-icon.png` | `platform/web/apple-touch-icon.png` | `1fe7316a83fab7104d813aec1caab593b5983e5225ce1f86a54ccb35f0f9ede1` |

浏览器图标在 `src/web/index.html` 中声明，`symbol-compact.svg` 由 `BrandMark` 组件从 `/brand/symbol-compact.svg` 加载；服务端仅按精确路径公开这四个文件。
