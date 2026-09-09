// cloud-storage.js
// Supabase 認証およびプロジェクトデータのクラウド保存管理モジュール

import { getSupabaseClient } from './supabase-config.js?v=1.01';

export class CloudStorage {
    constructor() {
        this.client = getSupabaseClient();
        this.currentUser = null;
        this.currentProjectId = null;
        this.onUserChangeCallbacks = [];

        if (this.client) {
            // セッション変更リスナー
            this.client.auth.onAuthStateChange((event, session) => {
                this.currentUser = session ? session.user : null;
                console.log('[CloudStorage] Auth state changed:', event, this.currentUser?.email);
                this._notifyUserChange();
            });

            // 初期セッション取得
            this.client.auth.getSession().then(({ data: { session } }) => {
                this.currentUser = session ? session.user : null;
                this._notifyUserChange();
            }).catch(err => {
                console.error('[CloudStorage] Failed to get session:', err);
            });
        }
    }

    /**
     * ユーザー変更リスナーの登録
     * @param {(user: import('@supabase/supabase-js').User | null) => void} callback
     */
    onUserChange(callback) {
        if (typeof callback === 'function') {
            this.onUserChangeCallbacks.push(callback);
            callback(this.currentUser);
        }
    }

    _notifyUserChange() {
        this.onUserChangeCallbacks.forEach(cb => {
            try { cb(this.currentUser); } catch (e) { console.error(e); }
        });
    }

    /**
     * メールアドレスとパスワードでサインイン
     */
    async signInWithPassword(email, password) {
        if (!this.client) throw new Error('Supabase クライアントが初期化されていません');
        const { data, error } = await this.client.auth.signInWithPassword({
            email,
            password
        });
        if (error) throw error;
        return data;
    }

    /**
     * メールアドレスとパスワードでサインアップ（新規登録）
     */
    async signUpWithPassword(email, password) {
        if (!this.client) throw new Error('Supabase クライアントが初期化されていません');
        const { data, error } = await this.client.auth.signUp({
            email,
            password
        });
        if (error) throw error;
        return data;
    }

    /**
     * ソーシャルログイン (Google, GitHub 等)
     * @param {'google' | 'github'} provider
     */
    async signInWithOAuth(provider) {
        if (!this.client) throw new Error('Supabase クライアントが初期化されていません');
        const { data, error } = await this.client.auth.signInWithOAuth({
            provider: provider,
            options: {
                redirectTo: window.location.origin + window.location.pathname
            }
        });
        if (error) throw error;
        return data;
    }

    /**
     * サインアウト（ログアウト）
     */
    async signOut() {
        if (!this.client) return;
        const { error } = await this.client.auth.signOut();
        this.currentProjectId = null;
        if (error) throw error;
    }

    /**
     * プロジェクト一覧を取得（更新日時の降順）
     */
    async listProjects() {
        if (!this.client) throw new Error('Supabase クライアントが初期化されていません');
        if (!this.currentUser) throw new Error('ログインが必要です');

        const { data, error } = await this.client
            .from('projects')
            .select('id, name, created_at, updated_at, data')
            .order('updated_at', { ascending: false });

        if (error) throw error;
        return data || [];
    }

    /**
     * プロジェクトを保存（新規作成または既存上書き）
     * @param {string} name - プロジェクト名
     * @param {object} projectData - state の全データ
     * @param {string|null} projectId - 指定時の対象ID
     * @param {boolean} forceNew - true の場合は常に新規作成
     */
    async saveProject(name, projectData, projectId = null, forceNew = false) {
        if (!this.client) throw new Error('Supabase クライアントが初期化されていません');
        if (!this.currentUser) throw new Error('プロジェクトを保存するにはログインが必要です');

        const targetId = forceNew ? null : (projectId || this.currentProjectId);
        const now = new Date().toISOString();

        if (targetId) {
            // 既存上書き
            const { data, error } = await this.client
                .from('projects')
                .update({
                    name: name,
                    data: projectData,
                    updated_at: now
                })
                .eq('id', targetId)
                .select();

            if (error) throw error;
            this.currentProjectId = targetId;
            return data && data[0] ? data[0] : { id: targetId, name };
        } else {
            // 新規作成
            const { data, error } = await this.client
                .from('projects')
                .insert([{
                    name: name,
                    data: projectData,
                    created_at: now,
                    updated_at: now
                }])
                .select();

            if (error) throw error;
            if (data && data[0]) {
                this.currentProjectId = data[0].id;
                return data[0];
            }
            return null;
        }
    }

    /**
     * プロジェクト名の変更（リネーム）
     */
    async renameProject(projectId, newName) {
        if (!this.client) throw new Error('Supabase クライアントが初期化されていません');
        if (!this.currentUser) throw new Error('ログインが必要です');

        const { data, error } = await this.client
            .from('projects')
            .update({
                name: newName,
                updated_at: new Date().toISOString()
            })
            .eq('id', projectId)
            .select();

        if (error) throw error;
        return data && data[0] ? data[0] : null;
    }

    /**
     * 特定のプロジェクトを取得
     */
    async loadProject(projectId) {
        if (!this.client) throw new Error('Supabase クライアントが初期化されていません');
        if (!this.currentUser) throw new Error('ログインが必要です');

        const { data, error } = await this.client
            .from('projects')
            .select('*')
            .eq('id', projectId)
            .single();

        if (error) throw error;
        if (data) {
            this.currentProjectId = data.id;
        }
        return data;
    }

    /**
     * プロジェクトを削除
     */
    async deleteProject(projectId) {
        if (!this.client) throw new Error('Supabase クライアントが初期化されていません');
        if (!this.currentUser) throw new Error('ログインが必要です');

        const { error } = await this.client
            .from('projects')
            .delete()
            .eq('id', projectId);

        if (error) throw error;
        if (this.currentProjectId === projectId) {
            this.currentProjectId = null;
        }
        return true;
    }
}
