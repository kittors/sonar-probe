/*
 * 首帧主题。
 *
 * 必须在样式表生效、body 开始渲染之前把 data-theme 定下来，否则深色用户每次刷新
 * 都会先看到一帧白底。所以它是 index.html <head> 里的同步脚本，不进打包 ——
 * 打包后的入口是 module 脚本，要等整包下载完才执行，那时早已画过一帧了。
 *
 * 为什么是单独的文件而不是内联：服务端的 CSP 是 script-src 'self'，内联脚本会被
 * 浏览器直接拦掉（开发环境的 Vite 不发 CSP，所以本地看不出来）。放宽成
 * 'unsafe-inline' 等于把 CSP 防 XSS 的作用整个废掉；写 sha256 又会在每次改脚本时
 * 悄悄失效。同源外链最省心。
 */
(function () {
  var root = document.documentElement;
  try {
    var saved = localStorage.getItem('sonar-theme');
    root.dataset.theme =
      saved === 'light' || saved === 'dark'
        ? saved
        : window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
  } catch (e) {
    // 隐私模式下读 localStorage 可能直接抛错
    root.dataset.theme = 'light';
  }
  // 首帧禁用过渡：页面刚落地时不该有任何动画，否则会看到颜色"渐入"。
  // 由 lib/theme.ts 在页面挂载两帧后解除
  root.dataset.themeBoot = '1';
})();
