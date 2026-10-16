/**
 * 增量更新分层判定（打包器与测试共用，避免两处实现漂移）。
 *
 * 三个层的「保留」谓词（true = 收进该包），以及给 makeUpdateZip 用的 skip 谓词
 * （⚠️ makeUpdateZip 的 skip 语义是「返回 true 即**排除**」，与 copyDirFiltered 相反）。
 *
 * 分层归属：
 *   程序层 = 代码 + 工作区包（node_modules/@juting/*）
 *   依赖层 = 纯第三方依赖（node_modules 下除 @juting 外的一切）
 *   媒体层 = presets/<key>/media
 * 程序包排除 temp/（覆盖安装本就跳过它，属纯死重）。
 */
import path from 'node:path';

export const normRel = (rel) => rel.split(path.sep).join('/');
export const underTemp = (rel) => {
    const n = normRel(rel);
    return n === 'temp' || n.startsWith('temp/');
};
export const underNodeModules = (rel) => {
    const n = normRel(rel);
    return n === 'node_modules' || n.startsWith('node_modules/');
};
// 媒体路径判定必须同时认「目录本身」与「其下内容」——collectEntries 对目录调用 skip，
// 若只匹配 `presets/<key>/media/`（带尾斜杠），`presets/cet6/media` 这个目录名不匹配，
// 整棵子树会被当非媒体跳过（实测 media.zip 打成 0 个文件的原因）。
export const isMediaPath = (rel) => /^presets\/[^/]+\/media(\/|$)/.test(normRel(rel));
// 媒体树的祖先目录（presets、presets/<key>）：媒体包要保留它们才能承载子树。
export const isMediaAncestor = (rel) => {
    const n = normRel(rel);
    return n === 'presets' || /^presets\/[^/]+$/.test(n);
};
export const isWorkspacePkg = (rel) => /^node_modules\/@juting(\/|$)/.test(normRel(rel));
// 第三方依赖路径。⚠️ node_modules 与 node_modules/@juting 是**容器目录**，不算第三方依赖，
// 否则整棵子树会被容器级的排除判定切掉（程序层就拿不到 @juting/* 了）。
export const isThirdPartyDep = (rel) => {
    const n = normRel(rel);
    if (n === 'node_modules' || n === 'node_modules/@juting') return false;
    return underNodeModules(n) && !isWorkspacePkg(n);
};

export const programKeep = (rel) => {
    const n = normRel(rel);
    if (underTemp(n)) return false;
    if (isMediaPath(n)) return false;
    if (isThirdPartyDep(n)) return false;
    return true;
};
export const depsKeep = (rel) => {
    const n = normRel(rel);
    if (n === 'node_modules') return true;   // 容器目录，承载第三方子树
    return isThirdPartyDep(n);
};
export const mediaKeep = (rel) => isMediaPath(rel) || isMediaAncestor(rel);

// 给 makeUpdateZip 的 skip 谓词（true = 排除）
export const programSkip = (rel) => !programKeep(rel);
export const depsSkip = (rel) => !depsKeep(rel);
export const mediaSkip = (rel) => !mediaKeep(rel);
