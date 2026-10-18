import { useState } from 'react'
import type { AppSettings, DataDirInfo, MediaToolsStatus } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'

interface Props {
  settings: AppSettings | null
  dataDir: DataDirInfo | null
  mediaTools: MediaToolsStatus | null
  onChange: (patch: Partial<AppSettings>) => void
  onSelectMediaTools: () => void
  onClearMediaTools: () => void
  onReset: () => void
  onOpenDatabaseFolder: () => void
}

export function SettingsPanel({
  settings,
  dataDir,
  mediaTools,
  onChange,
  onSelectMediaTools,
  onClearMediaTools,
  onReset,
  onOpenDatabaseFolder
}: Props) {
  const [confirmReset, setConfirmReset] = useState(false)
  const value = settings ?? DEFAULT_SETTINGS

  return (
    <div className="flex flex-col gap-4 px-4 py-4 text-[11.5px]">
      <SectionTitle>媒体工具</SectionTitle>
      <div className={`rounded-lg border px-2.5 py-2 ${mediaTools?.ready ? 'border-ok/30 bg-ok/10' : 'border-warn/40 bg-warn/10'}`}>
        <div className="flex items-center justify-between gap-2">
          <span className={mediaTools?.ready ? 'text-ok' : 'text-warn'}>
            {mediaTools?.ready ? 'FFmpeg 可用' : 'FFmpeg 未配置'}
          </span>
          <span className="text-[10px] text-tertiary">
            {mediaTools?.source === 'environment'
              ? '环境变量'
              : mediaTools?.source === 'configured'
                ? '手动目录'
                : mediaTools?.source === 'path'
                  ? '系统 PATH'
                  : mediaTools?.source === 'development'
                    ? '开发目录'
                    : '未检测到'}
          </span>
        </div>
        <div className="mt-1 break-all text-[10.5px] leading-relaxed text-secondary">
          {mediaTools?.ready ? mediaTools.directory : mediaTools?.message ?? '正在检测…'}
        </div>
        <div className="mt-2 flex gap-2">
          <button className="btn text-[11px] hover:bg-ink-700/70" onClick={onSelectMediaTools}>
            {mediaTools?.ready ? '更换目录' : '选择 bin 目录'}
          </button>
          {mediaTools?.source === 'configured' && (
            <button className="btn text-[11px] hover:bg-ink-700/70" onClick={onClearMediaTools}>
              恢复自动检测
            </button>
          )}
        </div>
      </div>

      <SectionTitle>索引质量</SectionTitle>
      <Field
        label="抽帧上限"
        hint="实际帧数按时长自动分档，这里是封顶值。超过约 48 帧后会自动改用更快的抽帧方式，调大不会明显变慢。"
        value={value.framesPerVideo}
        min={8}
        max={400}
        step={8}
        onChange={(v) => onChange({ framesPerVideo: v })}
      />
      <Field
        label="并发任务"
        hint="机械硬盘建议 1~2，固态可以 3~4。"
        value={value.concurrency}
        min={1}
        max={8}
        onChange={(v) => onChange({ concurrency: v })}
      />
      <Field
        label="匹配阈值"
        hint="低于该结构相似度的帧会被直接丢弃，调低可召回更多弱匹配。"
        value={Math.round(value.minHashScore * 100)}
        min={50}
        max={95}
        onChange={(v) => onChange({ minHashScore: v / 100 })}
      />
      <Field
        label="结果数量"
        hint="搜索结果条数上限。"
        value={value.maxResults}
        min={5}
        max={200}
        onChange={(v) => onChange({ maxResults: v })}
      />
      <SectionTitle>监视与存储</SectionTitle>
      <Field
        label="新文件等待"
        hint="避免把还在复制/下载中的文件入库。"
        value={value.awaitWriteMs}
        min={300}
        max={10000}
        step={100}
        onChange={(v) => onChange({ awaitWriteMs: v })}
      />

      <label className="flex items-center gap-2 text-secondary">
        <input
          type="checkbox"
          checked={value.pruneOnDelete}
          onChange={(e) => onChange({ pruneOnDelete: e.target.checked })}
        />
        文件被删除时自动从库中移除
      </label>

      <label className="flex flex-col gap-1 text-secondary">
        <span className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={value.keepFrameImages}
            onChange={(e) => onChange({ keepFrameImages: e.target.checked })}
          />
          保留索引帧图片
        </span>
      </label>

      <label className="flex flex-col gap-1 text-secondary">
        <span className="text-[11.5px]">抽帧采样模式</span>
        <select
          className="rounded-lg border border-line bg-ink-900/60 px-2 py-1.5 text-[12px] text-primary"
          value={value.samplingMode}
          onChange={(e) => onChange({ samplingMode: e.target.value as 'uniform' | 'scene' })}
        >
          <option value="uniform">均匀采样 · 更快</option>
          <option value="scene">场景检测 · 更准</option>
        </select>
      </label>

      <label className="flex items-center gap-2 text-secondary">
        <input
          type="checkbox"
          checked={value.updateCheck}
          onChange={(e) => onChange({ updateCheck: e.target.checked })}
        />
        启动时检查更新
      </label>

      <div className="rounded-lg border border-line/70 bg-ink-900/60 px-2.5 py-2 text-[10.5px] leading-relaxed">
        <div className="flex items-center gap-1.5">
          <span className="text-secondary">数据目录</span>
          <span className="rounded border border-ok/40 bg-ok/10 px-1.5 py-0.5 text-[10px] text-ok">
            {dataDir?.source === 'env' ? '环境变量指定' : '程序目录'}
          </span>
        </div>
        <div className="mt-1 break-all font-mono text-[10px] text-secondary" title={dataDir?.dir}>
          {dataDir?.dir ?? '（读取中）'}
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <button className="btn text-[11.5px] hover:bg-ink-700/70" onClick={onOpenDatabaseFolder}>
          打开索引库位置
        </button>
        {confirmReset ? (
          <>
            <button
              className="btn btn-danger text-[11.5px] hover:bg-bad/10"
              onClick={() => {
                setConfirmReset(false)
                onReset()
              }}
            >
              确认清空
            </button>
            <button className="btn text-[11.5px] hover:bg-ink-700/70" onClick={() => setConfirmReset(false)}>
              取消
            </button>
          </>
        ) : (
          <button
            className="btn btn-danger text-[11.5px] hover:bg-bad/10"
            onClick={() => setConfirmReset(true)}
          >
            清空索引库
          </button>
        )}
      </div>
      <p className="text-[10.5px] text-tertiary">清空索引库不会删除视频文件。</p>
    </div>
  )
}

function Field({
  label,
  hint,
  value,
  min,
  max,
  step = 1,
  onChange
}: {
  label: string
  hint: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
}) {
  return (
    <div title={hint}>
      <div className="flex items-center justify-between">
        <span className="text-secondary">{label}</span>
        <span className="font-mono text-accent">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-accent"
      />
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="border-b border-line pb-1.5 text-[10.5px] font-medium uppercase tracking-wider text-tertiary">{children}</div>
}
