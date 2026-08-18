import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export default function TerminalConsole({ directory }) {
  const containerRef = useRef(null)

  useEffect(() => {
    if (!containerRef.current || !directory) return undefined
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 12,
      theme: { background: '#17191c', foreground: '#d7f8ef', cursor: '#5eead4', selectionBackground: '#28504c' },
      scrollback: 5000,
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(containerRef.current)
    terminal.focus()
    containerRef.current.addEventListener('click', () => terminal.focus())
    const resize = () => { fit.fit(); window.directoryAPI.resizeTerminal({ cols: terminal.cols, rows: terminal.rows }) }
    const dataCleanup = window.directoryAPI.onTerminalData(data => terminal.write(data))
    const exitCleanup = window.directoryAPI.onTerminalExit(() => terminal.write('\r\n[Process exited]\r\n'))
    const input = terminal.onData(data => { void window.directoryAPI.writeTerminal(data) })
    const observer = new ResizeObserver(resize)
    observer.observe(containerRef.current)
    window.directoryAPI.startTerminal(directory).then(resize).catch(error => terminal.write(`\r\n\x1b[31m${error.message}\x1b[0m\r\n`))
    resize()
    return () => { observer.disconnect(); input.dispose(); dataCleanup?.(); exitCleanup?.(); window.directoryAPI.stopTerminal(); terminal.dispose() }
  }, [directory])

  return <div className="terminal-console" ref={containerRef} />
}
