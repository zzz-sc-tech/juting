import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * 渲染期错误兜底：任何未捕获异常都落在这里，而不是整页白屏。
 *
 * 能兜住的：组件渲染、生命周期、子组件构造过程中的同步异常。
 * 兜不住的：事件处理器、setTimeout、Promise rejection——那些要各自 try/catch，
 * 这里的定位是「最后一道网」，不是万能的错误处理。
 *
 * 文案先安抚再给操作：进度本来就存在本机 localStorage，崩溃不会丢，
 * 所以要明确告诉用户；技术详情默认折叠，别一上来就吓人。
 */
type Props = {
  children: ReactNode
  /** 出错区域的名字（如「学习页」），用于标题与骨架屏以外的定位信息 */
  scope?: string
}

type State = { error: Error | null; info: ErrorInfo | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info })
    // 保留现场：浏览器控制台里有完整栈与组件栈，方便复现
    console.error('[ErrorBoundary]', this.props.scope ?? '', error, info.componentStack)
  }

  private handleReload = () => {
    // 整页重载：最彻底，能清掉坏掉的模块状态
    window.location.reload()
  }

  private handleHome = () => {
    // 不用 history.back()：上一页很可能就是刚崩的页面，退回去会立刻再崩一次。
    // 回首页 = 换一条健康的渲染路径；仍是同一次整页加载，状态干净。
    window.location.assign('/home')
  }

  render() {
    if (!this.state.error) return this.props.children
    const { error, info } = this.state
    return (
      <div className="error-boundary" role="alert">
        <span className="error-boundary-eyebrow">出错</span>
        <h1>{this.props.scope ? `${this.props.scope}没能加载` : '这一页出问题了'}</h1>
        <p>你的学习进度没有丢失（存在本机）。可以重新加载试试。</p>
        <div className="error-boundary-actions">
          <button className="command-button" onClick={this.handleReload} type="button">
            重新加载
          </button>
          <button className="command-button ghost" onClick={this.handleHome} type="button">
            回到首页
          </button>
        </div>
        <details>
          <summary>技术详情</summary>
          <pre>{error.message || String(error)}</pre>
          {info?.componentStack && <pre>{info.componentStack}</pre>}
        </details>
      </div>
    )
  }
}
