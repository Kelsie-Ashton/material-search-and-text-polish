export default function SearchPage() {
  return (
    <section className="page">
      <h2 className="page-title">检索</h2>
      <p className="page-desc">
        输入关键词，在本地素材库中检索文件名、标签与已提取的正文。
      </p>

      <div className="placeholder">
        <p>检索功能将在「素材库与检索」阶段接入。</p>
        <p className="placeholder-hint">
          当前为骨架版本，用于验证前后端联调与构建链路。
        </p>
      </div>
    </section>
  )
}
