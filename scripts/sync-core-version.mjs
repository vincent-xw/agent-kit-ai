import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagePath = resolve(repositoryRoot, 'packages/core/package.json')
const sourcePath = resolve(repositoryRoot, 'packages/core/src/index.ts')

// 以 core 的 package.json 为版本来源；缺少版本时直接失败，不用默认值补齐。
const corePackage = JSON.parse(await readFile(packagePath, 'utf8'))
if (typeof corePackage.version !== 'string' || corePackage.version.length === 0) {
  throw new Error('packages/core/package.json 缺少有效的 version')
}

const source = await readFile(sourcePath, 'utf8')
const declarations = [...source.matchAll(/^export const AGENT_KIT_VERSION = '[^']+'$/gm)]
// 限定唯一目标声明，防止版本同步时静默修改错误内容。
if (declarations.length !== 1) {
  throw new Error(`预期找到一个 AGENT_KIT_VERSION 导出，实际找到 ${declarations.length} 个`)
}

const currentDeclaration = declarations[0][0]
const nextDeclaration = `export const AGENT_KIT_VERSION = '${corePackage.version}'`
if (currentDeclaration !== nextDeclaration) {
  await writeFile(sourcePath, source.replace(currentDeclaration, nextDeclaration))
}

console.log(`AGENT_KIT_VERSION 已同步为 ${corePackage.version}`)
