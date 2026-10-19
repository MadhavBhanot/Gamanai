import {createClient} from '@supabase/supabase-js';

export function createSupabaseClient() {
    const supabaseUrl = process.env.VITE_SUPABASE_URL!;
    const supabaseAnonKey = process.env.VITE_SUPABASE_SECRET_KEY!;
    return createClient(supabaseUrl, supabaseAnonKey);
}