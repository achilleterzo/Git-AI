import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export default function TerminalConsole({ directory, visible = true }) {
  const containerRef = useRef(null)
  const terminalRef = useRef(null)
  const fitRef = useRef(null)
  const sessionRef = useRef(null)

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
    terminalRef.current = terminal
    fitRef.current = fit
    const focusTerminal = () => terminal.focus()
    containerRef.current.addEventListener('click', focusTerminal)
    const resize = () => { fit.fit(); if (sessionRef.current !== null) void window.directoryAPI.resizeTerminal({ cols: terminal.cols, rows: terminal.rows }, sessionRef.current) }
    const dataCleanup = window.directoryAPI.onTerminalData(data => terminal.write(data))
    const exitCleanup = window.directoryAPI.onTerminalExit(() => terminal.write('\r\n[Process exited]\r\n'))
    const input = terminal.onData(data => { if (sessionRef.current !== null) void window.directoryAPI.writeTerminal(data, sessionRef.current) })
    const observer = new ResizeObserver(resize)
    observer.observe(containerRef.current)
    let disposed = false
    window.directoryAPI.startTerminal(directory).then(result => {
      if (disposed) { if (result?.sessionId !== undefined) void window.directoryAPI.stopTerminal(result.sessionId); return }
      sessionRef.current = result?.sessionId ?? null
      resize()
    }).catch(error => terminal.write(`\r\n\x1b[31m${error.message}\x1b[0m\r\n`))
    resize()
    return () => { disposed = true; observer.disconnect(); input.dispose(); dataCleanup?.(); exitCleanup?.(); containerRef.current?.removeEventListener('click', focusTerminal); const sessionId = sessionRef.current; sessionRef.current = null; if (sessionId !== null) void window.directoryAPI.stopTerminal(sessionId); terminalRef.current = null; fitRef.current = null; terminal.dispose() }
  }, [directory])

  useEffect(() => {
    if (!visible || !terminalRef.current) return undefined
    const timer = requestAnimationFrame(() => { fitRef.current?.fit(); terminalRef.current?.focus(); requestAnimationFrame(() => terminalRef.current?.focus()) })
    return () => cancelAnimationFrame(timer)
  }, [visible])

  return <div className="terminal-console" ref={containerRef} />
}
