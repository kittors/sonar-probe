# 国家/地区旗帜

来自 [flag-icons](https://github.com/lipis/flag-icons) v7.5.0 的 `flags/4x3`，MIT 许可。

旗帜图案不适合手绘 —— 香港的紫荆花、英国的米字旗、韩国的太极卦象，画歪了比不画更糟，
所以这里直接用成熟数据集的原始 SVG，未作修改。

按 ISO 3166-1 alpha-2 小写命名（`hk.svg`、`jp.svg`），由 `CountryBadge` 组件按需请求，
浏览器只会下载实际出现在页面上的那几面。

## 更新

```bash
pnpm add -D flag-icons
cp node_modules/flag-icons/flags/4x3/*.svg public/flags/
pnpm remove flag-icons
```
