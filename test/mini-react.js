/**
 * 一个够用的迷你 React，只为在单测里**真的把面板渲染出来**。
 *
 * 为什么不用真的 React：客户端插件在运行时从宿主的模块表里 `require('react')`
 * （社区插件的做法），本仓库不该为了跑测试把它拉成 devDependency——那会让
 * `npm test` 依赖一份和宿主版本无关的 React。
 *
 * 它实现的是本面板真正用到的那一小块：`createElement`、`useState`、`useEffect`、
 * `useCallback`，外加「setState 触发整棵树重渲染」和「effect 在渲染后按序 flush」。
 * 够用来抓「渲染路径抛异常」「setState 后不更新」「effect 依赖写错导致死循环」，
 * 抓不到的是 React 自己的调度与批处理语义——那些不需要我们操心。
 *
 * 实例按**树中的位置**认领（`root>0.1`），与 React 用位置匹配 hook 的规则一致。
 * @module dsh-account-bridge/test/mini-react
 */

/** 依赖数组是否与上次相同。 */
function sameDeps(a, b) {
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (!Object.is(a[index], b[index])) return false
  }
  return true
}

/** 展平 children，丢掉 `null`/`undefined`/布尔（与 React 一致）。 */
function flatten(children, out = []) {
  for (const child of children) {
    if (Array.isArray(child)) flatten(child, out)
    else if (child === null || child === undefined || typeof child === 'boolean') continue
    else out.push(child)
  }
  return out
}

export function createMiniReact() {
  /** 位置 → `{hooks, cursor}`。 */
  const instances = new Map()
  let renderDepth = 0
  let currentPath = 'root'
  let pendingEffects = []
  let lastTree

  function nodeAt(path) {
    let instance = instances.get(path)
    if (!instance) {
      instance = { hooks: [], cursor: 0 }
      instances.set(path, instance)
    }
    instance.cursor = 0
    return instance
  }

  /** 在一个实例的上下文里调用函数组件。 */
  function withInstance(path, fn) {
    const previous = currentPath
    currentPath = path
    nodeAt(path)
    try {
      return fn()
    } finally {
      currentPath = previous
    }
  }

  function hookSlot() {
    const instance = instances.get(currentPath)
    if (!instance) throw new Error(`hook called outside a component (path ${currentPath})`)
    const index = instance.cursor
    instance.cursor += 1
    return { instance, index }
  }

  function createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: flatten(children) } }
  }

  function useState(initial) {
    const { instance, index } = hookSlot()
    if (!(index in instance.hooks)) {
      instance.hooks[index] = typeof initial === 'function' ? initial() : initial
    }
    const setState = (next) => {
      const value = typeof next === 'function' ? next(instance.hooks[index]) : next
      if (Object.is(value, instance.hooks[index])) return
      instance.hooks[index] = value
      // 面板的写操作全是「setState 之后重渲染」，这里同步重跑一遍树即可。
      if (renderDepth === 0) render(lastTree)
    }
    return [instance.hooks[index], setState]
  }

  function useEffect(effect, deps) {
    const { instance, index } = hookSlot()
    const previous = instance.hooks[index]
    if (previous && sameDeps(previous.deps, deps)) return
    instance.hooks[index] = { deps, cleanup: previous?.cleanup }
    pendingEffects.push({ instance, index, effect })
  }

  function useCallback(fn, deps) {
    const { instance, index } = hookSlot()
    const previous = instance.hooks[index]
    // 依赖没变时**必须返回上一次那个函数**，不是这次的。
    // 返回新函数会让 `useEffect(fn, [thatCallback])` 每一轮都认为依赖变了，
    // 于是「取数 → setState → 重渲染 → 依赖又变 → 再取数」转成死循环。
    if (previous && sameDeps(previous.deps, deps)) return previous.fn
    instance.hooks[index] = { deps, fn }
    return fn
  }

  function useRef(initial) {
    const { instance, index } = hookSlot()
    if (!(index in instance.hooks)) instance.hooks[index] = { current: initial }
    return instance.hooks[index]
  }

  /** 把元素树走成可断言的结构；函数组件会被真的调用。 */
  function walk(node, path) {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return { kind: 'text', text: String(node) }
    if (Array.isArray(node)) {
      return node.map((child, index) => walk(child, `${path}.${index}`)).filter(Boolean)
    }
    const { type, props } = node
    if (typeof type === 'function') {
      const rendered = withInstance(`${path}<${type.name || 'anon'}>`, () => type(props))
      return { kind: 'component', name: type.name, props, render: walk(rendered, `${path}<${type.name || 'anon'}>`) }
    }
    if (typeof type === 'string') {
      return {
        kind: 'host',
        tag: type,
        props: props ?? {},
        children: ((props ?? {}).children ?? []).map((child, index) => walk(child, `${path}.${index}`)).filter(Boolean),
      }
    }
    return null
  }

  function flushEffects() {
    const queue = pendingEffects
    pendingEffects = []
    for (const { instance, index, effect } of queue) {
      instance.hooks[index].cleanup = effect() ?? instance.hooks[index].cleanup
    }
  }

  /** 渲染一次并返回可断言的树。 */
  function render(element) {
    lastTree = element
    renderDepth += 1
    let tree
    try {
      tree = walk(element, 'root')
    } finally {
      renderDepth -= 1
    }
    flushEffects()
    return tree
  }

  /** 卸载：跑掉所有 effect 的 cleanup。 */
  function unmount() {
    for (const instance of instances.values()) {
      for (const hook of instance.hooks) hook?.cleanup?.()
    }
    instances.clear()
  }

  const React = {
    createElement,
    useState,
    useEffect,
    useCallback,
    useRef,
    Fragment: Symbol('Fragment'),
  }

  return { React, render, unmount, instances: () => instances }
}

// ---------------------------------------------------------------- 断言辅助

/** 深度优先找出所有满足条件的节点。 */
export function findAll(tree, predicate) {
  const out = []
  const visit = (node) => {
    if (!node) return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (predicate(node)) out.push(node)
    if (node.children) for (const child of node.children) visit(child)
    if (node.render) visit(node.render)
  }
  visit(tree)
  return out
}

/** 树里所有文本，拼起来。 */
export function textOf(tree) {
  return findAll(tree, (node) => node.kind === 'text')
    .map((node) => node.text)
    .join(' ')
}

/** 按标签名找宿主节点。 */
export function hostsOf(tree, tag) {
  return findAll(tree, (node) => node.kind === 'host' && node.tag === tag)
}
