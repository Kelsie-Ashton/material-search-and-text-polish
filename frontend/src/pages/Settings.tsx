export default function SettingsPage() {
  return (
    <section className="page">
      <h2 className="page-title">设置</h2>
      <p className="page-desc">
        在此填写你自己的云端模型 API Key。密钥只保存在本机，不会进入代码仓库。
      </p>

      <div className="placeholder">
        <p>凭证配置将在「凭证闭环」阶段接入。</p>
        <p className="placeholder-hint">
          未填写 API Key 时，润色功能会被禁用，但检索与文字提取仍可正常使用。
        </p>
      </div>
    </section>
  )
}
