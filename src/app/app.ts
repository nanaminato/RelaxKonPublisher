import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HubConnection, HubConnectionBuilder, HubConnectionState, LogLevel } from '@microsoft/signalr';

interface PublisherPaths { relaxKonOSPath: string; relaxKonServerPath: string; contentOutputPath: string; }
interface HistoryDecision { relativePath: string; copyToOutput: boolean; isDownloadable: boolean; }
interface ExistingPackage { relativePath: string; fileName: string; size: number; version?: string; runtime?: string; packageKind?: string; isDownloadable: boolean; }
interface OutputChange { relativePath: string; action: string; reason: string; }
interface PreflightCheck { name: string; passed: boolean; detail: string; }
interface DownloadChange { action: string; fileName: string; detail: string; }
interface JobLogEntry { timestamp: string; level: string; message: string; }
interface PublisherPreview { paths: PublisherPaths; gitRoot?: string; head?: string; gitStatus?: string; presets: string[]; existingPackages: ExistingPackage[]; changes: OutputChange[]; warnings: string[]; preflightChecks: PreflightCheck[]; }
interface PublisherJob { id: string; state: string; step: string; error?: string; affectedFiles: string[]; progressCurrent: number; progressTotal: number; cancellationRequested: boolean; downloadChanges: DownloadChange[]; logs: JobLogEntry[]; }
interface PublisherPlan { paths: PublisherPaths; version: string; runtimes: string[]; clientRuntimes: string[]; serverRuntimes: string[]; buildClient: boolean; buildServer: boolean; includeChecksums: boolean; includeDescriptors: boolean; includeInstallers: boolean; onlyLatestDownloadable: boolean; historicalPackages: HistoryDecision[]; }

@Component({ imports: [CommonModule, FormsModule], selector: 'app-root', styleUrl: './app.css', templateUrl: './app.html' })
export class App implements OnInit, OnDestroy {
  private readonly api = 'http://127.0.0.1:5112/api/publisher';
  private readonly hubUrl = 'http://127.0.0.1:5112/hubs/publisher';
  private hub?: HubConnection;
  private previewTimeout?: number;
  readonly clientRuntimes = ['win-x64', 'win-arm64', 'linux-x64', 'linux-arm64', 'osx-arm64'];
  readonly serverRuntimes = ['win-x64', 'win-arm64', 'linux-x64', 'linux-arm64'];
  paths: PublisherPaths = { relaxKonOSPath: '', relaxKonServerPath: '', contentOutputPath: '' };
  version = ''; selectedClientRuntimes = ['win-x64']; selectedServerRuntimes = ['win-x64']; buildClient = true; buildServer = true; includeChecksums = true; includeDescriptors = true; includeInstallers = false; onlyLatestDownloadable = false;
  histories: HistoryDecision[] = []; preview?: PublisherPreview; job?: PublisherJob; busy = false; message = '正在读取本机发布者设置…'; error = ''; canRetryPreview = false; realtimeConnected = false; liveLogs: JobLogEntry[] = []; previewInProgress = false;

  constructor(private readonly zone: NgZone, private readonly changeDetector: ChangeDetectorRef) { }

  get progressPercent(): number { return this.job?.progressTotal ? Math.round(this.job.progressCurrent / this.job.progressTotal * 100) : 0; }
  get jobIsActive(): boolean { return this.job !== undefined && ['queued', 'running'].includes(this.job.state); }

  async ngOnInit(): Promise<void> {
    try {
      await this.connectRealtime();
      const defaults = await this.request<PublisherPaths>('/settings');
      const saved = localStorage.getItem('relaxkon.publisher.paths');
      this.paths = saved ? { ...defaults, ...JSON.parse(saved) as PublisherPaths } : defaults;
      this.message = '请选择一个或多个目标平台，然后预览输出差异和构建前检查。';
    } catch (error) { this.error = this.errorText(error); }
    finally { this.requestViewRefresh(); }
  }

  ngOnDestroy(): void { if (this.previewTimeout) window.clearTimeout(this.previewTimeout); void this.hub?.stop(); }

  isClientRuntimeSelected(runtime: string): boolean { return this.selectedClientRuntimes.includes(runtime); }
  isServerRuntimeSelected(runtime: string): boolean { return this.selectedServerRuntimes.includes(runtime); }

  toggleClientRuntime(runtime: string, checked: boolean): void {
    this.selectedClientRuntimes = checked ? [...this.selectedClientRuntimes, runtime] : this.selectedClientRuntimes.filter(item => item !== runtime);
    this.preview = undefined;
  }

  toggleServerRuntime(runtime: string, checked: boolean): void {
    this.selectedServerRuntimes = checked ? [...this.selectedServerRuntimes, runtime] : this.selectedServerRuntimes.filter(item => item !== runtime);
    this.preview = undefined;
  }

  async previewPlan(): Promise<boolean> {
    if (!this.validatePlan()) return false;
    this.busy = true; this.previewInProgress = true; this.error = ''; this.canRetryPreview = false; this.liveLogs = []; this.message = '正在执行只读构建前检查并扫描旧发布数据…';
    try {
      this.savePaths();
      await this.connectRealtime();
      this.previewTimeout = window.setTimeout(() => this.finishPreviewFailure('预览在 15 秒内未收到完成事件。请检查 SignalR 连接和后端日志。'), 15_000);
      await this.hub!.send('StartPreview', this.plan());
      return true;
    } catch (error) { this.finishPreviewFailure(this.errorText(error)); return false; }
  }

  async generate(): Promise<void> {
    if (!this.validatePlan()) return;
    if (!this.preview) { await this.previewPlan(); return; }
    const replacements = this.preview?.changes.filter(change => change.action === '替换') ?? [];
    if (replacements.length && !window.confirm(`将以可恢复方式替换 ${replacements.length} 个独立输出文件。继续生成？`)) return;
    this.busy = true; this.error = '';
    try {
      await this.connectRealtime();
      this.liveLogs = [];
      this.job = await this.request<PublisherJob>('/generate', this.plan());
      await this.hub!.invoke('Subscribe', this.job.id);
      this.message = '发布任务已开始；状态与执行日志将通过 SignalR 实时更新。';
    } catch (error) { this.error = this.errorText(error); } finally { this.busy = false; }
  }

  async cancel(): Promise<void> {
    if (!this.job || !['queued', 'running'].includes(this.job.state)) return;
    try {
      this.job = await this.request<PublisherJob>(`/jobs/${this.job.id}/cancel`, {});
      this.applyJobUpdate(this.job);
      this.message = '已请求取消，正在安全停止当前构建。';
    } catch (error) { this.error = this.errorText(error); }
  }

  private plan(): PublisherPlan {
    const runtimes = [...new Set([...this.selectedClientRuntimes, ...this.selectedServerRuntimes])];
    return { paths: this.paths, version: this.version.trim(), runtimes, clientRuntimes: this.selectedClientRuntimes, serverRuntimes: this.selectedServerRuntimes, buildClient: this.buildClient, buildServer: this.buildServer, includeChecksums: this.includeChecksums, includeDescriptors: this.includeDescriptors, includeInstallers: this.includeInstallers, onlyLatestDownloadable: this.onlyLatestDownloadable, historicalPackages: this.histories };
  }

  private validatePlan(): boolean {
    const version = this.version.trim();
    if (!version) { this.error = '请输入版本号，例如 0.1.2。'; return false; }
    if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(version)) {
      this.error = '版本号只能包含字母、数字、点、下划线和连字符。';
      return false;
    }
    if (this.buildClient && !this.selectedClientRuntimes.length) { this.error = '至少选择一个客户端目标平台。'; return false; }
    if (this.buildServer && !this.selectedServerRuntimes.length) { this.error = '至少选择一个服务端目标平台。'; return false; }
    if (!this.buildClient && !this.buildServer && !this.includeInstallers) {
      this.error = '至少选择客户端 ZIP、服务端 ZIP 或复制安装器中的一项。';
      return false;
    }
    return true;
  }

  private savePaths(): void { localStorage.setItem('relaxkon.publisher.paths', JSON.stringify(this.paths)); }

  private async connectRealtime(): Promise<void> {
    if (!this.hub) {
      this.hub = new HubConnectionBuilder()
        .withUrl(this.hubUrl)
        .withAutomaticReconnect()
        .configureLogging(LogLevel.Warning)
        .build();
      // SignalR invokes handlers outside Angular's render scheduler.  NgZone.run alone is
      // a no-op for rendering when this application runs zoneless, so every external
      // notification must explicitly mark the view dirty.
      this.hub.on('jobUpdated', (job: PublisherJob) => this.applyRealtimeUpdate(() => this.applyJobUpdate(job)));
      this.hub.on('previewLog', (entry: JobLogEntry) => this.applyRealtimeUpdate(() => this.appendLiveLog(entry.level, entry.message, entry.timestamp)));
      this.hub.on('previewCompleted', (preview: PublisherPreview) => this.applyRealtimeUpdate(() => this.finishPreview(preview)));
      this.hub.on('previewFailed', (message: string) => this.applyRealtimeUpdate(() => this.finishPreviewFailure(message)));
      this.hub.onclose(() => this.applyRealtimeUpdate(() => {
        this.realtimeConnected = false;
        if (this.jobIsActive) this.error = '与本机发布服务的实时连接已断开；任务状态无法继续自动更新。';
      }));
      this.hub.onreconnected(async () => {
        this.applyRealtimeUpdate(() => { this.realtimeConnected = true; this.error = ''; });
        const activeJob = this.job;
        if (activeJob && ['queued', 'running'].includes(activeJob.state)) await this.hub?.invoke('Subscribe', activeJob.id);
      });
    }
    if (this.hub.state === HubConnectionState.Connected) { this.realtimeConnected = true; return; }
    if (this.hub.state === HubConnectionState.Disconnected) await this.hub.start();
    else throw new Error('本机发布服务的 SignalR 实时连接正在重连，请稍后重试。');
    this.realtimeConnected = true;
  }

  private applyJobUpdate(job: PublisherJob): void {
    this.job = job;
    this.liveLogs = job.logs ?? [];
    this.message = job.step;
    if (job.state === 'failed') this.error = job.error ?? '发布任务失败。';
    if (job.state === 'cancelled') this.message = '任务已取消；独立输出保持不变。';
  }

  private appendLiveLog(level: string, message: string, timestamp = new Date().toISOString()): void {
    this.liveLogs = [...this.liveLogs, { timestamp, level, message }].slice(-1_000);
  }

  private applyRealtimeUpdate(update: () => void): void {
    this.zone.run(() => {
      update();
      this.requestViewRefresh();
    });
  }

  private requestViewRefresh(): void { this.changeDetector.markForCheck(); }

  private finishPreview(preview: PublisherPreview): void {
    if (this.previewTimeout) window.clearTimeout(this.previewTimeout);
    this.previewTimeout = undefined;
    this.preview = preview;
    this.histories = preview.existingPackages.filter(item => item.relativePath.endsWith('.zip')).map(item => ({ relativePath: item.relativePath, copyToOutput: false, isDownloadable: item.isDownloadable }));
    this.message = '检查通过；预览不会修改任何目录。';
    this.busy = false;
    this.previewInProgress = false;
  }

  private finishPreviewFailure(message: string): void {
    if (this.previewTimeout) window.clearTimeout(this.previewTimeout);
    this.previewTimeout = undefined;
    this.error = message;
    this.appendLiveLog('error', message);
    this.canRetryPreview = true;
    this.busy = false;
    this.previewInProgress = false;
  }

  private async request<T>(path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeoutMilliseconds = 15_000;
    const timeout = window.setTimeout(() => controller.abort(), timeoutMilliseconds);
    try {
      const response = await fetch(`${this.api}${path}`, body === undefined
        ? { signal: controller.signal }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      const payload = await response.json() as T & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `请求失败（${response.status}）`);
      return payload;
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`本机发布 API 在 ${timeoutMilliseconds / 1000} 秒内没有响应。请确认服务正在运行，然后重试。`);
      throw error;
    } finally { window.clearTimeout(timeout); }
  }

  private errorText(error: unknown): string { return error instanceof Error ? error.message : '发生未知错误。'; }
}
