export function userColor(name: string): string {
    const colors: string[] = [
        'bg-blue-600/20 text-blue-400',
        'bg-purple-600/20 text-purple-400',
        'bg-green-600/20 text-green-400',
        'bg-amber-600/20 text-amber-400',
        'bg-rose-600/20 text-rose-400',
        'bg-teal-600/20 text-teal-400',
        'bg-orange-600/20 text-orange-400',
        'bg-pink-600/20 text-pink-400',
    ];
    let hash: number = 0;
    for (let i: number = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
}