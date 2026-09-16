import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';

interface PublisherPaths { relaxKonOSPath: string; relaxKonServerPath: string; contentOutputPath: string; }
interface HistoryDecision { relativePath: string; copyToOutput: boolean; isDownloadable: boolean; }
interface ExistingPackage { relativePath: string; fileName: string; size: number; version?: string; runtime?: string; packageKind?: string; isDownloadable: boolean; }
interface OutputChange { relativePath: string; action: string; reason: string; }
interface PublisherPreview { paths: PublisherPaths; gitRoot?: string; head?: string; gitStatus?: string; presets: string[]; existingPackages: ExistingPackage[]; changes: OutputChange[]; warnings: string[]; }
interface PublisherJob { id: string; state: string; step: string; error?: string; affectedFiles: string[]; }
interface PublisherPlan { paths: PublisherPaths; version: string; runtime: string; buildClient: boolean; buildServer: boolean; includeChecksums: boolean; includeDescriptors: boolean; includeInstallers: boolean; onlyLatestDownloadable: boolean; historicalPackages: HistoryDecision[]; }

@Component({ imports: [CommonModule, FormsModule], selector: 'app-root', styleUrl: './app.css', templateUrl: './app.html' })
export class App implements OnInit {
  private readonly api = 'http://127.0.0.1:5112/api/publisher';
  readonly runtimes = ['win-x64', 'win-arm64', 'linux-x64', 'linux-arm64'];
  paths: PublisherPaths = { relaxKonOSPath: '', relaxKonServerPath: '', contentOutputPath: '' };
  version = ''; runtime = 'win-x64'; buildClient = true; buildServer = true; includeChecksums = true; includeDescriptors = true; includeInstallers = false; onlyLatestDownloadable = false;
  histories: HistoryDecision[] = []; preview?: PublisherPreview; job?: PublisherJob; busy = false; message = '正在读取本机发布者设置…'; error = '';

  async ngOnInit(): Promise<void> {
    try { const defaults = await this.request<PublisherPaths>('/settings'); const saved = localStorage.getItem('relaxkon.publisher.paths'); this.paths = saved ? { ...defaults, ...JSON.parse(saved) as PublisherPaths } : defaults; this.message = '请确认绝对路径和发布计划，然后预览输出差异。'; }
    catch (error) { this.error = this.errorText(error); }
  }
  async previewPlan(): Promise<void> {
    this.busy = true; this.error = ''; this.message = '正在只读扫描旧发布数据…';
    try { this.savePaths(); this.preview = await this.request<PublisherPreview>('/preview', this.plan()); this.histories = this.preview.existingPackages.filter(item => item.relativePath.endsWith('.zip')).map(item => ({ relativePath: item.relativePath, copyToOutput: false, isDownloadable: item.isDownloadable })); this.message = '预览完成；生成前不会修改任何目录。'; }
    catch (error) { this.error = this.errorText(error); } finally { this.busy = false; }
  }
  async generate(): Promise<void> {
    if (!this.preview) { await this.previewPlan(); if (!this.preview) return; }
    const replacements = this.preview.changes.filter(change => change.action === '替换');
    if (replacements.length && !window.confirm(`将以可恢复方式替换 ${replacements.length} 个独立输出文件。继续生成？`)) return;
    this.busy = true; this.error = '';
    try { this.job = await this.request<PublisherJob>('/generate', this.plan()); this.message = '发布任务已开始。'; await this.pollJob(this.job.id); }
    catch (error) { this.error = this.errorText(error); } finally { this.busy = false; }
  }
  private plan(): PublisherPlan { return { paths: this.paths, version: this.version.trim(), runtime: this.runtime, buildClient: this.buildClient, buildServer: this.buildServer, includeChecksums: this.includeChecksums, includeDescriptors: this.includeDescriptors, includeInstallers: this.includeInstallers, onlyLatestDownloadable: this.onlyLatestDownloadable, historicalPackages: this.histories }; }
  private savePaths(): void { localStorage.setItem('relaxkon.publisher.paths', JSON.stringify(this.paths)); }
  private async pollJob(id: string): Promise<void> { do { await new Promise(resolve => setTimeout(resolve, 1000)); this.job = await this.request<PublisherJob>(`/jobs/${id}`); this.message = this.job.step; } while (this.job.state === 'queued' || this.job.state === 'running'); if (this.job.state === 'failed') this.error = this.job.error ?? '发布任务失败。'; }
  private async request<T>(path: string, body?: unknown): Promise<T> { const response = await fetch(`${this.api}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const payload = await response.json() as T & { error?: string }; if (!response.ok) throw new Error(payload.error ?? `请求失败（${response.status}）`); return payload; }
  private errorText(error: unknown): string { return error instanceof Error ? error.message : '发生未知错误。'; }
}
