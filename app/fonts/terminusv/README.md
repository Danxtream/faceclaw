# TerminusV (Variable Width) & TerminusC (Fixed Width Condensed)

Two Bitmap Fonts, based on the original Terminus font.

Only glyphs for iso8859-1 (a.k.a. Western or Latin-1) are implemented, and only two rather small sizes (9 and 12 pixel).

Published under the [Open Font License][1].

Thanks go to Dimitar Zhekov for creating the original Terminus font, 
explaining what an Open Font License is and not minding me messing around with his work
or having the original font name in its name.

Comparison to the regular Terminus font:  
![Screenshot][2]

## PCF fonts

### Manual Installation

Copy all files inside `pcf` to an _existing_ folder that is in Xorg's font path, usually `/usr/share/fonts/misc` or `/usr/share/fonts/local`, but you could also have added a folder under your `$HOME`, e.g. `xset fp+ ~/.local/share/fonts/terv-terc`.

Open a terminal in the folder you just copied the files into and enter:

	mkfontdir
	fc-cache -f
	xset fp rehash

This should be enough for the Xserver's database, but other graphical applications
may not see the fonts until you log out/in.

### Automatic installation

Run the script `install_pcf.sh`, it will go through the same steps described above
and install the fonts to existing system directories.  
It relies on `sudo`.

## OTB fonts

It should be enough to copy the `otb` folder to one of the standard fontconfig locations, e.g. `~/.local/share/fonts/` or `/usr/share/fonts/`.

You might need to run `fc-cache -f` afterwards.

## Other Information

If you haven't been using PCF or BDF bitfonts/pixelfonts on your desktop until now, [here's what you need to do first](https://iamfuss.deviantart.com/journal/How-to-install-artwiz-pixel-fonts-in-Ubuntu-226000883).

Additionally, you might want to

- disable bitmap font scaling (because it's ugly) by deleting `*-scale-bitmap-fonts.conf` from `/etc/fonts/conf.d`
- disable creation of artificial italic/bold fonts by deleting `*-synthetic.conf` from  `/etc/fonts/conf.d`

Forum thread:
https://bbs.archlinux.org/viewtopic.php?id=173065

[1]: https://scripts.sil.org/OFL
[2]: https://dt.iki.fi/stuff/blog/terv-compare.png
