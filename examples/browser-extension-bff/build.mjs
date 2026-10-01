/**
 * esbuild 打包配置：把 BFF 的所有 JS（含 workspace 包、hono、zod）打成一个单文件 CJS bundle。
 *
 * 打完后再用 @yao-pkg/pkg 把 Node 运行时 + bundle 打成二进制。
 * node:* 模块全部 externalize -- pkg 内置的 Node 提供这些。
 */
import { build } from 'esbuild'

const result = await build({
  entryPoints: ['dist/server.js'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'dist/server.bundle.cjs',
  // node:* 模块由 pkg 内置的 Node 运行时提供，不打包进去。
  external: ['node:*'],
  // 生成 sourcemap 方便排查，pkg 打包时会忽略它。
  sourcemap: true,
  // 跳过 minify -- 方便排查，体积差异对 pkg 产物影响不大。
  minify: false,
  // 日志级别
  logLevel: 'info',
})

console.log('Bundle 完成：dist/server.bundle.cjs')
