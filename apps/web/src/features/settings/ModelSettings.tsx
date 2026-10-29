import React, {useState, useEffect} from 'react';
import {ModelProfile, EmbeddingModelCatalog, listEmbeddingModels, saveProfile, testProfileDraft, deleteProfile, selectEmbeddingModel, downloadEmbeddingModel, importEmbeddingModel} from '../../api';
import {useAutoDismiss} from '../../useAutoDismiss';

export function ModelSettings({profiles, onClose, onSaved}: {profiles: ModelProfile[]; onClose: () => void; onSaved: () => Promise<void>}) {
  type ProfileForm = Omit<ModelProfile, 'id'> & {id?: string; api_key: string};
  const initial = profiles.find(item => item.is_default) || profiles[0];
  const blank: ProfileForm = {name: '我的模型', endpoint: '', model: '', api_key: '', temperature: 0.2, max_tokens: 2048, is_default: true};
  const [selectedId, setSelectedId] = useState(initial?.id || '');
  const [form, setForm] = useState<ProfileForm>({
    id: initial?.id,
    name: initial?.name || '我的模型',
    endpoint: initial?.endpoint || '',
    model: initial?.model || '',
    api_key: '',
    temperature: initial?.temperature ?? 0.2,
    max_tokens: initial?.max_tokens ?? 2048,
    is_default: true,
  });
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [embeddingCatalog, setEmbeddingCatalog] = useState<EmbeddingModelCatalog | null>(null);
  const [embeddingBusy, setEmbeddingBusy] = useState('');
  const [importBaseModel, setImportBaseModel] = useState('BAAI/bge-small-zh-v1.5');
  const [importFile, setImportFile] = useState<File | null>(null);

  useAutoDismiss(error, () => setError(''));
  useAutoDismiss(message, () => setMessage(''), 5000);

  const refreshEmbeddingModels = async () => setEmbeddingCatalog(await listEmbeddingModels());
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);
  useEffect(() => { void refreshEmbeddingModels().catch(reason => setError(reason instanceof Error ? reason.message : '向量模型读取失败')); }, []);
  const field = (name: string, value: string | number | boolean) => setForm(current => ({...current, [name]: value}));
  const chooseProfile = (id: string) => {
    const profile = profiles.find(item => item.id === id);
    setSelectedId(id); setError(''); setMessage('');
    if (profile) setForm({...profile, api_key: ''});
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setError('');
    try { await saveProfile(form); await onSaved(); }
    catch (error) { setError(error instanceof Error ? error.message : '保存失败'); setSaving(false); }
  };
  const testCurrent = async () => {

    setSaving(true); setError(''); setMessage('');
    try { const result = await testProfileDraft(form); setMessage(`连接成功（使用当前填写参数，未保存配置）：${result.response}`); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '连接测试失败'); }
    finally { setSaving(false); }
  };
  const removeCurrent = async () => {
    if (!form.id || !window.confirm(`确定删除模型配置“${form.name}”吗？`)) return;
    setSaving(true); setError('');
    try { await deleteProfile(form.id); await onSaved(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '删除失败'); setSaving(false); }
  };
  const activateEmbedding = async (modelId: string) => {
    setEmbeddingBusy(modelId); setError(''); setMessage('');
    try {
      const result = await selectEmbeddingModel(modelId);
      await refreshEmbeddingModels();
      setMessage(`已切换向量模型，并重建 ${result.reindexed_chunks} 个文本片段。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '向量模型切换失败'); }
    finally { setEmbeddingBusy(''); }
  };
  const downloadEmbedding = async (modelName: string) => {
    setEmbeddingBusy(modelName); setError(''); setMessage('');
    try {
      const model = await downloadEmbeddingModel(modelName);
      await refreshEmbeddingModels();
      setMessage(`${model.name} 已下载到本地，可以选择使用。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '向量模型下载失败'); }
    finally { setEmbeddingBusy(''); }
  };
  const importEmbedding = async () => {
    if (!importFile) { setError('请选择 FastEmbed ONNX 模型 ZIP 压缩包。'); return; }
    setEmbeddingBusy('import'); setError(''); setMessage('');
    try {
      const model = await importEmbeddingModel(importFile, importFile.name.replace(/\.zip$/i, ''), importBaseModel);
      setImportFile(null); await refreshEmbeddingModels();
      setMessage(`${model.name} 已导入本地，可以选择使用。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '向量模型导入失败'); }
    finally { setEmbeddingBusy(''); }
  };
  return <div className="modal-backdrop" onMouseDown={event => {if (event.target === event.currentTarget) onClose();}}><form className="settings-card" role="dialog" aria-modal="true" aria-labelledby="model-settings-title" onSubmit={submit}>
    <div className="settings-title"><div><small>OpenAI-compatible</small><h2 id="model-settings-title">模型配置</h2></div><button type="button" className="ghost" onClick={onClose}>关闭</button></div>
    <div className="settings-body">
      <div className="profile-picker"><select aria-label="选择模型配置" value={selectedId} onChange={event => chooseProfile(event.target.value)}><option value="">新建配置</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}</select><button type="button" onClick={() => {setSelectedId(''); setForm(blank); setError(''); setMessage('');}}>＋ 新建</button></div>
      <label>配置名称<input value={form.name} onChange={event => field('name', event.target.value)}/></label>
      <label>API Base URL、Chat Completions 或 Responses Endpoint<input value={form.endpoint} onChange={event => field('endpoint', event.target.value)} placeholder="https://api.deepseek.com"/><small className="field-hint">明确填写 /responses 时使用 Responses API；基础地址默认补全 /chat/completions。</small></label>
      <label>模型名称<input value={form.model} onChange={event => field('model', event.target.value)} placeholder="模型 ID"/></label>
      <label>API Key<input value={form.api_key} onChange={event => field('api_key', event.target.value)} type="password" placeholder={form.id ? '留空表示不修改' : '保存在本机，不写入数据库'}/><small className="field-hint">优先使用系统凭据管理器；不可用时保存在本项目的本地数据目录中。</small></label>
      <div className="settings-grid"><label>Temperature<input type="number" min="0" max="2" step="0.1" value={form.temperature} onChange={event => field('temperature', Number(event.target.value))}/></label><label>最大输出 Token<input type="number" min="1" max="16384" value={form.max_tokens} onChange={event => field('max_tokens', Number(event.target.value))}/></label></div>
      <section className="embedding-settings">
        <header><div><small>LOCAL EMBEDDING</small><h3>向量模型</h3></div><span>模型与教材向量均保存在本机</span></header>
        <div className="embedding-model-list">{embeddingCatalog?.models.map(model => <article key={model.id} className={embeddingCatalog.active_id === model.id ? 'active' : ''}><div><strong>{model.name}</strong><small>{model.model_name} · {model.dimension} 维{model.size_gb ? ` · 约 ${Math.round(model.size_gb * 1024)} MB` : ''}</small><p>{model.description}</p></div><button type="button" disabled={Boolean(embeddingBusy) || embeddingCatalog.active_id === model.id} onClick={() => void activateEmbedding(model.id)}>{embeddingCatalog.active_id === model.id ? '使用中' : embeddingBusy === model.id ? '重建中…' : '使用此模型'}</button></article>)}</div>
        <div className="embedding-downloads"><strong>从网络下载</strong>{embeddingCatalog?.presets.map(model => {const installed = embeddingCatalog.models.some(item => item.model_name === model.model_name); return <article key={model.model_name}><span><b>{model.name}</b><small>{model.dimension} 维 · 约 {Math.round(model.size_gb * 1024)} MB</small></span><button type="button" disabled={Boolean(embeddingBusy) || installed} onClick={() => void downloadEmbedding(model.model_name)}>{installed ? '已下载' : embeddingBusy === model.model_name ? '下载中…' : '下载到本机'}</button></article>;})}</div>
        <div className="embedding-import"><strong>从本地导入</strong><p>导入与所选基础模型格式一致的 FastEmbed ONNX ZIP 压缩包。</p><select value={importBaseModel} onChange={event => setImportBaseModel(event.target.value)}>{embeddingCatalog?.presets.map(model => <option value={model.model_name} key={model.model_name}>{model.name}</option>)}</select><label className="embedding-file">{importFile ? importFile.name : '选择模型 ZIP'}<input type="file" accept=".zip,application/zip" onChange={event => setImportFile(event.target.files?.[0] || null)}/></label><button type="button" disabled={Boolean(embeddingBusy) || !importFile} onClick={() => void importEmbedding()}>{embeddingBusy === 'import' ? '正在验证…' : '导入模型'}</button></div>
      </section>
      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}
    </div>
    <div className="settings-actions">{form.id && <button type="button" className="danger" disabled={saving} onClick={() => void removeCurrent()}>删除</button>}<button type="button" className="ghost" disabled={saving} onClick={() => void testCurrent()}>测试连接</button><button className="primary" disabled={saving}>{saving ? '处理中…' : '保存并设为默认'}</button></div>
  </form></div>;
}
