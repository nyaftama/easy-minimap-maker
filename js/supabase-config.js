// supabase-config.js
// Supabase 接続設定

export const SUPABASE_URL = 'https://bvjfiweejbnidwdequci.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_wxdTNBydT8UGFyZlzvvFfw_-L71pnq2';

/**
 * Supabase クライアントの取得
 * @returns {import('@supabase/supabase-js').SupabaseClient | null}
 */
export function getSupabaseClient() {
    if (typeof window !== 'undefined' && window.supabase && window.supabase.createClient) {
        if (!window._supabaseClientInstance) {
            window._supabaseClientInstance = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
                auth: {
                    persistSession: true,
                    autoRefreshToken: true,
                    detectSessionInUrl: true
                }
            });
        }
        return window._supabaseClientInstance;
    }
    console.warn('[Supabase] SDK not loaded on window.supabase');
    return null;
}
