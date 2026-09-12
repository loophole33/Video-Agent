import { useEffect, useRef, useState } from 'react';
import { CornerDownLeft, Sparkles } from 'lucide-react';
import { useAgent } from '../store/agentStore';
import { cn } from '../lib/utils';

const QUICK = ['做条 20s 抖音种草视频，突出 0 糖', '太贵了，便宜点', '第 1 个镜头换成特写', '开始生成吧', '这次用了多少钱'];

export function AgentChat() {
  const messages = useAgent((s) => s.messages);
  const send = useAgent((s) => s.send);
  const thinking = useAgent((s) => s.thinking);
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, thinking]);

  const submit = () => {
    if (!text.trim()) return;
    send(text);
    setText('');
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col border-t border-bay-800">
      <header className="flex items-center gap-1.5 px-3 py-2">
        <Sparkles className="size-3.5 text-sodium-500" />
        <span className="eyebrow">agent</span>
        <span className="ml-auto font-mono text-[11.5px] text-bone-400">同一份图的另一个入口</span>
      </header>

      <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-2">
        {messages.map((m) => (
          <div
            key={m.id}
            className={cn(
              'rounded-md px-2.5 py-1.5 text-[13.5px] leading-relaxed',
              m.role === 'user'
                ? 'ml-6 border border-bay-700 bg-bay-800 text-bone-200'
                : 'mr-2 border border-bay-800 bg-bay-950 text-bone-300',
            )}
          >
            {m.text}
            {m.questions && m.questions.length > 0 && (
              <ul className="mt-1 space-y-[2px]">
                {m.questions.map((q) => (
                  <li key={q} className="font-mono text-[12px] text-sodium-500">
                    ? {q}
                  </li>
                ))}
              </ul>
            )}
            {m.patchId && (
              <span className="mt-1 block font-mono text-[11.5px] text-bone-400">
                已生成提案 {m.patchId}（右侧提案卡可预览 / 接受 / 拒绝）
              </span>
            )}
          </div>
        ))}
        {thinking && (
          <div className="mr-2 flex items-center gap-1.5 rounded-md border border-bay-800 bg-bay-950 px-2.5 py-1.5">
            <span className="size-1.5 animate-breathe rounded-full bg-sodium-500" />
            <span className="size-1.5 animate-breathe rounded-full bg-sodium-500 [animation-delay:150ms]" />
            <span className="size-1.5 animate-breathe rounded-full bg-sodium-500 [animation-delay:300ms]" />
            <span className="font-mono text-[12px] text-bone-400">规划中…</span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1 px-3 pb-1.5">
        {QUICK.map((q) => (
          <button
            key={q}
            className="chip hover:border-sodium-600 hover:text-sodium-400"
            onClick={() => send(q)}
            title="快速试一句"
          >
            {q}
          </button>
        ))}
      </div>

      <div className="flex items-end gap-1.5 border-t border-bay-800 p-2">
        <textarea
          data-testid="agent-input"
          className="field h-[54px] resize-none"
          placeholder="说一句话，我来搭流程或改节点…（Enter 发送，Shift+Enter 换行）"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="btn btn-primary h-[54px] !px-2.5" onClick={submit} data-testid="agent-send" aria-label="发送">
          <CornerDownLeft className="size-3.5" />
        </button>
      </div>
    </section>
  );
}
