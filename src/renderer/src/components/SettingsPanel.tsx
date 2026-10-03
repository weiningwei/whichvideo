import { useState } from 'react'
import type { AppSettings, DataDirInfo } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'

interface Props {
  settings: AppSettings | null
  dataDir: DataDirInfo | null
  /** 初始是否展开（测试与深链用） */
  initialOpen?: boolean
  onChange: (patch: Partial<AppSettings>) => void
  onReset: () => void
  onOpenDatabaseFolder: () => void
}

export function SettingsPanel({
  settings,
  dataDir,
  initialOpen = false,
  onChange,
  onReset,
  onOpenDatabaseFolder
}: Props) {
  const [open, setOpen] = useState(initialOpen)
  const [confirmReset, setConfirmReset] = useState(false)
  const value = settings ?? DEFAULT_SETTINGS

  return (
    <div className="border-t border-line/70">
      <button
        className="flex w-full items-center justify-between px-4 py-2.5 text-[12.5px] text-slate-300 hover:bg-ink-800/40"
        onClick={() => setOpen((v) => !v)}
      >
        <span>索引设置</span>
        <span className="text-slate-500">{open ? '收起' : '展开'}</span>
      </button>

      {open && (
        <div className="flex flex-col gap-3 px-4 pb-4 text-[11.5px]">
          <Field
            label="每个视频抽帧数（上限）"
            hint="实际帧数按时长自动分档，这里是封顶值。调小会稀疏、调大更密，长视频尤其明显。"
            value={value.framesPerVideo}
            min={8}
            max={256}
            step={8}
            onChange={(v) => onChange({ framesPerVideo: v })}
          />
          <Field
            label="并发解码数"
            hint="机械硬盘建议 1~2，固态可以 3~4。"
            value={value.concurrency}
            min={1}
            max={8}
            onChange={(v) => onChange({ concurrency: v })}
          />
          <Field
            label="匹配阈值（%）"
            hint="低于该结构相似度的帧会被直接丢弃，调低可召回更多弱匹配。"
            value={Math.round(value.minHashScore * 100)}
            min={50}
            max={95}
            onChange={(v) => onChange({ minHashScore: v / 100 })}
          />
          <Field
            label="最多返回结果"
            hint="搜索结果条数上限。"
            value={value.maxResults}
            min={5}
            max={200}
            onChange={(v) => onChange({ maxResults: v })}
          />
          <Field
            label="新文件稳定等待（毫秒）"
            hint="避免把还在复制/下载中的文件入库。"
            value={value.awaitWriteMs}
            min={300}
            max={10000}
            step={100}
            onChange={(v) => onChange({ awaitWriteMs: v })}
          />

          <label className="flex items-center gap-2 text-slate-300">
            <input
              type="checkbox"
              checked={value.pruneOnDelete}
              onChange={(e) => onChange({ pruneOnDelete: e.target.checked })}
            />
            文件被删除时自动从库中移除
          </label>

          <div className="rounded-lg border border-line/70 bg-ink-900/60 px-2.5 py-2 text-[10.5px] leading-relaxed">
            <div className="flex items-center gap-1.5">
              <span className="text-slate-400">数据目录</span>
              {dataDir?.portable ? (
                <span className="rounded border border-ok/40 bg-ok/10 px-1.5 py-0.5 text-[10px] text-ok">
                  便携模式{dataDir.source === 'env' ? '（环境变量）' : ''}
                </span>
              ) : (
                <span className="rounded border border-line bg-ink-700/40 px-1.5 py-0.5 text-[10px] text-slate-400">
                  默认（用户目录）
                </span>
              )}
            </div>
            <div className="mt-1 break-all font-mono text-[10px] text-slate-400" title={dataDir?.dir}>
              {dataDir?.dir ?? '（读取中）'}
            </div>
            <div className="mt-1 text-slate-500">
              便携模式下索引库与缓存都写在这个目录，整个文件夹拷走即可迁移；也可用环境变量
              <span className="font-mono"> WHICHVIDEO_DATA_DIR </span>
              指定其他位置。
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
          <p className="text-[10.5px] leading-relaxed text-slate-500">
            清空只删除索引数据（数据库文件），不会动你的视频文件。修改设置后，重建索引才会生效。
          </p>
        </div>
      )}
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
    <div>
      <div className="flex items-center justify-between">
        <span className="text-slate-300">{label}</span>
        <span className="font-mono text-accent">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-[#38bdf8]"
      />
      <div className="text-[10px] leading-snug text-slate-500">{hint}</div>
    </div>
  )
}
