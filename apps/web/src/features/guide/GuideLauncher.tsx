import './GuideLauncher.css';

export function GuideLauncher({onOpen}: {onOpen: () => void}) {
  return <section className="guide-launcher" aria-labelledby="guide-launcher-title"><div><small>START HERE · 初次使用</small><h2 id="guide-launcher-title">把每一次阅读，变成有迹可循的学习</h2><p>从导入教材到 AI 助读、总结、笔记与复习，了解每项功能的用途和操作方法。</p></div><button onClick={onOpen}>打开使用指南 <span aria-hidden="true">↗</span></button></section>;
}
