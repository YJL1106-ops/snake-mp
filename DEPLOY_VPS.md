# Deploy updated client to VPS (snake-mp)

Because the VPS cannot reliably access github.com/cdn, the safest way to deploy is SCP the `public/` folder.

## 1) From your local machine (WSL)

```bash
cd /home/jiale/clawd
scp -r snake-mp/public ubuntu@43.143.251.49:/tmp/snake-mp-public
```

## 2) On VPS

```bash
sudo rm -rf /opt/snake-mp/public
sudo mv /tmp/snake-mp-public /opt/snake-mp/public
sudo chown -R ubuntu:ubuntu /opt/snake-mp/public
sudo systemctl restart snake-mp
sudo systemctl status snake-mp --no-pager
```

## Note about Phaser CDN
This client uses Phaser from jsDelivr:
`https://cdn.jsdelivr.net/npm/phaser@3.80.1/dist/phaser.min.js`

If jsDelivr is blocked for some players, we can vend a local copy of Phaser by downloading it once and serving it from `/public/vendor/phaser.min.js`.
