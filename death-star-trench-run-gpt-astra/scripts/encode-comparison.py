"""Composite the matched browser capture and untouched reference into one GIF."""
from pathlib import Path
import json
import subprocess

root = Path(__file__).resolve().parents[1]
work = root / 'output/reference-match'
reference = Path('/Users/christinehu/Downloads/fable51-bench/3d/starwars/trench-run.mp4')
destination = Path('/Users/christinehu/Downloads/gpt6-astra-vs-fable5.1.gif')
preview = work / 'side-by-side.mp4'

def run(*args):
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'warning', '-y', *args], check=True)

layout = (
    '[0:v]setpts=PTS-STARTPTS,fps=30,scale=640:360:flags=lanczos,setsar=1[left];'
    '[1:v]setpts=PTS-STARTPTS,fps=30,scale=640:360:flags=lanczos,setsar=1[right];'
    '[left][right]hstack=inputs=2:shortest=1, pad=1280:408:0:48:color=0x090d13[panels];'
    '[panels][2:v]overlay=0:0:shortest=1,'
    'drawbox=x=639:y=48:w=2:h=360:color=0x303944:t=fill,format=yuv420p[out]'
)
run('-i', str(work / 'astra-capture.webm'), '-i', str(reference),
    '-loop', '1', '-i', str(work / 'labels.png'),
    '-filter_complex', layout, '-map', '[out]', '-t', '28.2', '-an',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-movflags', '+faststart', str(preview))

palette = (
    '[0:v]fps=15,hqdn3d=4:3:6:4,'
    "lutyuv=y='if(lt(val,32),16,val)',split[a][b];"
    '[a]palettegen=max_colors=256:stats_mode=full[p];'
    '[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle[out]'
)
run('-i', str(preview), '-filter_complex', palette, '-map', '[out]',
    '-t', '28.2', '-loop', '0', str(destination))

probe = json.loads(subprocess.check_output([
    'ffprobe', '-v', 'error', '-show_entries',
    'format=duration,size:stream=width,height,nb_frames,r_frame_rate',
    '-of', 'json', str(destination)
]))
probe.update({'path': str(destination), 'left': 'gpt6-astra', 'right': 'fable5.1',
              'reference': str(reference), 'reference_duration': 28.2})
(work / 'gif-verification.json').write_text(json.dumps(probe, indent=2))
print(json.dumps(probe, indent=2))
