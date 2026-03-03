import React from 'react'
import { Link } from 'react-router-dom'

export default function Home() {
  return (
    <div style={{ fontFamily: 'DM Mono, monospace', background: '#07070e', color: '#d8d5cf', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center', maxWidth: 720, padding: 36 }}>
        <h1 style={{ fontFamily: 'Syne, sans-serif', fontSize: 40, marginBottom: 8 }}>
          Le<span style={{ color: '#22c55e' }}>an</span>
        </h1>
        <p style={{ color: '#9aa0a0', marginBottom: 18 }}>Financial document intelligence for analysts — parse proxy circulars, regulatory filings, and financial statements into structured, exportable data.</p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
          <Link to="/viewer" style={{ padding: '10px 18px', background: '#16a34a', color: '#fff', borderRadius: 6, textDecoration: 'none', fontWeight: 700 }}>Open Parser</Link>
          <a href="https://github.com/rtvasu/CompLift" target="_blank" rel="noreferrer" style={{ padding: '10px 18px', background: '#0c0c18', color: '#9aa0a0', borderRadius: 6, textDecoration: 'none' }}>Source</a>
        </div>
      </div>
    </div>
  )
}
