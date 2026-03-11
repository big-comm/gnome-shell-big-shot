# Plano de Implementação — Gravação de Vídeo (Big Shot)

## Visão Geral

A extensão Big Shot já possui toda a infraestrutura base para gravação de vídeo
via GNOME Screencast D-Bus service. Este documento detalha o estado atual, os
problemas conhecidos e as melhorias planejadas.

---

## Status Atual

### ✅ Infraestrutura Implementada

| Componente | Descrição | Arquivo |
|---|---|---|
| Detecção GPU | Auto-detect NVIDIA/AMD/Intel via `lspci` | `extension.js` → `detectGpuVendors()` |
| 8 Pipelines GStreamer | CUDA H.264, GL H.264, VAAPI LP, VAAPI, SW GL H.264, SW H.264, SW GL VP8, SW VP8 | `extension.js` → `VIDEO_PIPELINES` |
| Cascade automático | GPU hw → VAAPI → Software com fallback | `extension.js` → `_screencastCommonAsync` |
| Patch ScreencastAsync | Intercepta D-Bus para injetar pipeline customizado | `extension.js` → `_patchScreencast` |
| Botão de vídeo | Force-enable mesmo quando serviço crasheia | `extension.js` → `_forceEnableScreencast` |
| Correção Gst.init | Monkey-patch no launcher do serviço de screencast (GNOME 49 bug) | `/usr/share/gnome-shell/org.gnome.Shell.Screencast` |
| Áudio Desktop + Mic | Toggle buttons com detecção via Gvc.MixerControl | `parts/partaudio.js` |
| Framerate selector | 15/24/30/60 FPS | `parts/partframerate.js` |
| Downsize selector | 100%/75%/50% da resolução | `parts/partdownsize.js` |
| Indicador | Spinner + timer durante gravação | `parts/partindicator.js` |
| Quick Stop | Parada rápida | `parts/partquickstop.js` |

### 🔧 Bugs Conhecidos / Em Correção

#### 1. Áudio Desktop/Mic não funciona
**Causa raiz identificada:**
- Faltava `provide-clock=false` no `pulsesrc` — conflito de clock com `pipewiresrc`
- Canais de áudio hardcoded (`channels=2`) em vez de detectar do dispositivo
- Estrutura do `audiomixer` invertida (mixer antes das sources)
- Faltava `latency=100000000` no audiomixer para sincronização
- `GLib.shell_quote()` adicionava aspas extras no nome do device

**Correção aplicada:** Reescrita completa do `makeAudioInput()` baseada na
referência `gnome-shell-screencast-extra-feature`.

#### 2. Pipeline de áudio+vídeo com estrutura incorreta
**Causa raiz:** Segmentos do pipeline estavam na ordem errada.
O correto (conforme referência) é:
```
video ! muxer name=mux   audioSource ! audioPipeline ! mux.   mux.
```
Onde o screencast service prepend `pipewiresrc` e append `filesink`:
```
pipewiresrc ! video ! muxer name=mux   audioSource ! audioPipeline ! mux.   mux. ! filesink
```

**Correção aplicada:** `_makePipelineString()` reescrito.

---

## Melhorias Planejadas

### Fase 1 — Estabilização (Prioridade Alta)

#### 1.1 Validar gravação end-to-end
- [ ] Testar gravação sem áudio (só vídeo) — verificar cascade de pipelines
- [ ] Testar gravação com Desktop Audio
- [ ] Testar gravação com Mic
- [ ] Testar gravação com Desktop + Mic simultaneamente
- [ ] Verificar logs com `journalctl --user | grep "Big Shot"`
- [ ] Validar em hardware: NVIDIA, AMD, Intel e CPU-only

#### 1.2 Robustez do serviço de screencast
- [ ] Garantir que o patch `Gst.init` funciona em todas as situações
- [ ] Tratar reconexão automática se o serviço crashar
- [ ] Log detalhado de qual pipeline foi selecionado e por quê

### Fase 2 — Qualidade de Gravação (Prioridade Média)

#### 2.1 Seletor de qualidade
Inspirado no `big-video-converter`:
- [ ] Adicionar seletor: Alta / Média / Baixa
- [ ] Mapear para bitrates:
  - Alta: 40.000 kbps (HW) / 40.000.000 bps (SW)
  - Média: 20.000 kbps / 20.000.000 bps
  - Baixa: 10.000 kbps / 10.000.000 bps
- [ ] Criar novo Part: `PartQuality`

#### 2.2 Seletor de codec
- [ ] H.264 (padrão, máxima compatibilidade)
- [ ] H.265/HEVC (melhor compressão)
- [ ] VP8/VP9 (WebM, open source)
- [ ] AV1 (futuro, melhor compressão)
- [ ] Adicionar pipelines correspondentes em `VIDEO_PIPELINES`

#### 2.3 Seletor de formato de saída
- [ ] MP4 (padrão)
- [ ] WebM
- [ ] MKV (possível via `matroskamux`)

### Fase 3 — Funcionalidades Avançadas (Prioridade Baixa)

#### 3.1 Pós-processamento com FFmpeg/big-video-converter
- [ ] Após gravação, oferecer re-encoding via `big-video-converter`
  - Conversão de formato (WebM→MP4)
  - Ajuste de qualidade pós-gravação
  - Aplicar filtros (brilho, saturação)
- [ ] Chamar via `Gio.Subprocess` com env vars do big-video-converter:
  ```
  gpu=auto video_quality=high video_encoder=h264 big-video-converter recording.webm
  ```

#### 3.2 Gravação de janela específica
- [ ] Investigar viabilidade — GNOME Screencast D-Bus suporta apenas tela inteira ou área
- [ ] Alternativa: capturar geometria da janela e usar `ScreencastAreaAsync`
- [ ] Tracking de janela se ela mover durante gravação (complexo)

#### 3.3 Overlay durante gravação
- [ ] Desenhar anotações em tempo real durante screencast
- [ ] Requer pipeline com compositor (muito complexo via D-Bus)
- [ ] Alternativa: overlay via Clutter actor sobreposto

#### 3.4 GIF export
- [ ] Conversão pós-gravação de vídeo para GIF animado
- [ ] Via FFmpeg: `ffmpeg -i input.mp4 -vf "fps=10,scale=640:-1" output.gif`
- [ ] Ou via GStreamer com plugin gifenc

---

## Referências Técnicas

### Pipeline GStreamer — Anatomia
```
pipewiresrc                      ← Auto-prepended pelo serviço
  ! capsfilter caps=...          ← Filtro de framerate/formato
  ! encoder                      ← Codec (nvh264enc, vaapih264enc, openh264enc, vp8enc)
  ! parser                       ← Parse (h264parse)
  ! muxer name=mux               ← Container (mp4mux, webmmux)
pulsesrc device=X provide-clock=false  ← Fonte de áudio
  ! capsfilter caps=audio/x-raw,channels=N
  ! audioconvert
  ! queue
  ! audioEncoder                 ← (fdkaacenc, vorbisenc)
  ! queue
  ! mux.                         ← Conecta ao muxer
mux.                             ← Ponto de saída do muxer
  ! filesink                     ← Auto-appended pelo serviço
```

### Detecção de GPU — Paridade com big-video-converter
| Detecção | big-video-converter (bash) | Big Shot (GJS) |
|---|---|---|
| NVIDIA | `grep -i nvidia lspci` | `/nvidia/i.test(lspci)` |
| AMD | `grep -iE 'AMD\|ATI' lspci` | `/\bamd\b\|\bati\b/i.test(lspci)` |
| Intel | `grep -i intel lspci` | `/intel/i.test(lspci)` |
| Fallback | software encoder | VP8/OpenH264 software |

### Encoders — Correspondência
| big-video-converter | Big Shot GStreamer |
|---|---|
| `h264_nvenc` (FFmpeg) | `nvh264enc` (GStreamer) |
| `h264_vaapi` (FFmpeg) | `vaapih264enc` (GStreamer) |
| `libx264` (FFmpeg) | `openh264enc` (GStreamer) |
| `libvpx` (FFmpeg) | `vp8enc` (GStreamer) |
| `fdkaac` (FFmpeg) | `fdkaacenc` (GStreamer) |

---

## Viabilidade

**A gravação de vídeo é altamente viável porque:**

1. A infraestrutura de pipeline cascade com auto-detect de GPU **já está implementada**
2. O padrão é idêntico ao big-video-converter (detectar GPU → tentar HW → fallback software)
3. PipeWire + pulsesrc já funcionam no BigLinux
4. GStreamer no GNOME fornece encoders HW via plugins (gst-plugins-bad para VAAPI/NVENC)
5. Performance de HW encoding é excelente para screencast (< 5% CPU em NVIDIA/AMD)
6. Mesmo o fallback software (OpenH264/VP8 com cpu-used=5) é viável para resoluções até 1080p
